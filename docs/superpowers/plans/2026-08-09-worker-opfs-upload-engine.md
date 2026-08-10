# Worker + OPFS Resilient Upload Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (this project executes it as an ultracode workflow — one fresh agent per task, review after) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Read the spec first:** `docs/superpowers/specs/2026-08-09-worker-opfs-upload-engine-design.md`.

**Goal:** A dedicated-Web-Worker upload engine with an OPFS staged-part store that becomes the default multipart path, with the legacy main-thread pipeline retained untouched as fallback.

**Architecture:** Producer (slice-only reads, record-aligned chunks) → OPFS stager (rolling window, durable part records) → concurrent XHR uploaders (wall-clock stall detection) → validated completion, all inside a module worker; a main-thread client owns eligibility, message relay, cancel escalation, and wake lock. Engine state lives in its own IndexedDB database (`bolter-upload-engine`) with lease / completion-envelope / producer-checkpoint / per-part records enabling crash-window resume and `/upload/complete` replay.

**Tech Stack:** TypeScript, Vite module workers, OPFS `createSyncAccessHandle`, IndexedDB, XHR-in-worker, WebCrypto (existing `crypto.ts` ECE), client-zip/JSZip (existing `zip.ts`), vitest + happy-dom + fake-indexeddb, Playwright (new).

## Global Constraints

- Conventional commits; **never** any AI/Claude attribution or Co-Authored-By lines.
- Frontend tests: `cd apps/frontend && bunx vitest run <file>` (all: `bun run test`). Typecheck: `bun run typecheck` at repo root. Lint: `bun run check` at root before each commit.
- The legacy pipeline is **read-only**: no behavioral change to existing code paths in `api.ts`, `upload-state.ts`, or `zip.ts` beyond what a task explicitly lists. Existing test suites must stay green after every task.
- Files under `apps/frontend/src/lib/upload-engine/` and `apps/frontend/src/lib/upload-shared.ts` are **worker-safe**: no `window`, `document`, `navigator.onLine` reads, or DOM types. (`self`/`globalThis` OK.)
- Legacy IndexedDB is `bolter-uploads` — the engine must never open it. Engine DB: `bolter-upload-engine`.
- Path alias `@/` → `apps/frontend/src/`. New deps allowed: `@playwright/test` only (Task 16).
- For encrypted uploads, only ciphertext may be written to the part store — never plaintext.
- ECE record sizes: plaintext record 65,536 bytes; encrypted record 65,553 bytes (`getEffectivePartSize`, `api.ts:529`). R2/S3 minimum non-trailing part: `UPLOAD_LIMITS.MIN_PART_SIZE` = 5,242,880 bytes.

## Shared interfaces (the coordination contract — copy verbatim, do not rename)

All in `apps/frontend/src/lib/upload-engine/`. Later tasks import these exact names.

```ts
// protocol.ts
export interface EngineJob {
    fileId: string;
    uploadId: string;
    uploadToken?: string;
    ownerToken: string;
    partUrls: string[]; // index 0 = part 1
    partSize: number; // nominal per-part payload size (ciphertext size when encrypted)
    encrypted: boolean;
    secretKeyB64?: string;
    maxConcurrent: number;
    declaredTotalSize: number; // payload bytes declared at allocation (ciphertext when encrypted)
    source: EngineSource;
}
export type EngineSource =
    | { kind: 'file'; file: File }
    | { kind: 'blob'; blob: Blob }
    | { kind: 'zip'; files: File[]; names: string[] };
export type ClientToWorker =
    | { type: 'start'; job: EngineJob; envelope: CompletionEnvelope }
    | { type: 'resume'; fileId: string }
    | { type: 'cancel' }
    | { type: 'connectivity'; online: boolean };
export type WorkerToClient =
    | { type: 'progress'; bytesSent: number; totalBytes: number }
    | { type: 'retry' }
    | { type: 'cancelled' } // cancel ack — worker has aborted XHRs + called server abort
    | { type: 'error'; message: string; retryable: boolean }
    | { type: 'done'; actualSize: number };

// state.ts — record shapes (stored in DB `bolter-upload-engine`, version 1)
export interface EngineLease {
    fileId: string; uploadId: string; uploadToken?: string; ownerToken: string;
    createdAt: number; engineVersion: 1;
}
export interface CompletionEnvelope {
    fileId: string;
    metadata: string; // exact encrypted-metadata payload for /upload/complete
    authKeyB64: string;
    manifest: { name: string; size: number; type: string }[];
    zipFilename?: string;
    expectedSize: number;
    encrypted: boolean;
    secretKeyB64?: string;
    timeLimit: number;
    downloadLimit: number;
}
export interface ProducerCheckpoint {
    fileId: string;
    nextPartNumber: number; // 1-based; next part to produce
    sourceOffset: number; // bytes consumed from source (plaintext domain)
    eceCounter: number; // next ECE record sequence number
    eofReached: boolean;
    finalRecordEmitted: boolean;
}
export interface EnginePartRecord {
    fileId: string; partNumber: number; size: number;
    staged: boolean; uploaded: boolean; etag?: string;
}

// part-store.ts
export class PartStoreQuotaError extends Error {} // thrown on quota exhaustion; retryable
export interface PartStore {
    stagePart(partNumber: number, chunks: AsyncIterable<Uint8Array>): Promise<{ size: number }>;
    readPart(partNumber: number): Promise<Blob>;
    deletePart(partNumber: number): Promise<void>;
    listParts(): Promise<{ partNumber: number; size: number }[]>; // committed parts only
    destroy(): Promise<void>;
}

// state.ts — store API
export interface EngineStateStore {
    putLease(l: EngineLease): Promise<void>;
    getLease(fileId: string): Promise<EngineLease | undefined>;
    putEnvelope(e: CompletionEnvelope): Promise<void>;
    getEnvelope(fileId: string): Promise<CompletionEnvelope | undefined>;
    putCheckpoint(c: ProducerCheckpoint): Promise<void>;
    getCheckpoint(fileId: string): Promise<ProducerCheckpoint | undefined>;
    putPart(p: EnginePartRecord): Promise<void>;
    getParts(fileId: string): Promise<EnginePartRecord[]>; // sorted by partNumber
    listLeases(): Promise<EngineLease[]>;
    clearUpload(fileId: string): Promise<void>; // lease+envelope+checkpoint+parts
}

// engine.ts
export interface UploadPartResult { etag: string; }
export interface EngineDeps {
    store: PartStore;
    state: EngineStateStore;
    uploadPart(url: string, body: Blob, hooks: { onProgress(loaded: number): void; signal: AbortSignal }): Promise<UploadPartResult>;
    completeUpload(envelope: CompletionEnvelope, parts: { PartNumber: number; ETag: string }[], actualSize: number): Promise<void>;
    refreshPartUrls(fileId: string, uploadToken?: string): Promise<string[]>;
    abortUpload(fileId: string, uploadToken?: string): Promise<void>;
    now(): number; // wall clock (Date.now)
    isOnline(): boolean; // fed by connectivity relay
    onEvent(e: WorkerToClient): void;
}
export interface EngineResult { actualSize: number; }
export function runEngine(job: EngineJob, envelope: CompletionEnvelope, deps: EngineDeps, cancel: AbortSignal): Promise<EngineResult>;
```

---

### Task 1: Worker-safe shared helpers (`upload-shared.ts`)

**Files:**
- Create: `apps/frontend/src/lib/upload-shared.ts`
- Modify: `apps/frontend/src/lib/api.ts` (delete the moved function bodies; import + re-export from `./upload-shared`)
- Test: `apps/frontend/src/lib/__tests__/upload-shared.test.ts`

**Interfaces — Produces:** `getConcurrentUploads(fileSize: number): number` (move verbatim from `api.ts:553`), `isRetryableError(error: Error): boolean` (move verbatim from `api.ts:2890`), `retryDelayMs(attempt: number): number` (extract the backoff formula used at `api.ts:3471` — read that call site and lift the exact arithmetic into a pure function; update the call site to use it).

- [ ] **Step 1: Write the failing test**

```ts
// apps/frontend/src/lib/__tests__/upload-shared.test.ts
import { describe, expect, it } from 'vitest';
import { getConcurrentUploads, isRetryableError, retryDelayMs } from '../upload-shared';

describe('upload-shared', () => {
    it('is importable without DOM globals', async () => {
        const src = await import('fs').then((fs) =>
            fs.readFileSync(new URL('../upload-shared.ts', import.meta.url), 'utf8'),
        );
        expect(src).not.toMatch(/\bwindow\b|\bdocument\b|navigator\.onLine/);
    });
    it('scales concurrency with file size', () => {
        expect(getConcurrentUploads(1)).toBeGreaterThanOrEqual(1);
        expect(getConcurrentUploads(100 * 1024 ** 3)).toBeGreaterThanOrEqual(getConcurrentUploads(1));
    });
    it('classifies network-ish errors as retryable', () => {
        expect(isRetryableError(new Error('network error'))).toBe(true);
    });
    it('backoff grows with attempt', () => {
        expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
    });
});
```

- [ ] **Step 2:** `cd apps/frontend && bunx vitest run src/lib/__tests__/upload-shared.test.ts` — expect FAIL (module not found).
- [ ] **Step 3:** Create `upload-shared.ts`: move the two functions verbatim from `api.ts` (read them first; keep exact behavior incl. thresholds and error-message matching), add `retryDelayMs`. In `api.ts`: remove the moved bodies, add `import { getConcurrentUploads, isRetryableError, retryDelayMs } from './upload-shared'; export { getConcurrentUploads, isRetryableError };` (preserve any existing export status; `isRetryableError` is currently private — do not newly export from `api.ts` if it wasn't).
- [ ] **Step 4:** Re-run the new test (PASS) and the full suite: `bun run test` in `apps/frontend` — all green. `bun run typecheck` at root.
- [ ] **Step 5:** Commit: `refactor(frontend): extract worker-safe upload helpers to upload-shared`

---

### Task 2: `zip.ts` accepts injected per-file streams

**Files:**
- Modify: `apps/frontend/src/lib/zip.ts` (`createStreamingZip`, ~line 296)
- Test: extend `apps/frontend/src/lib/__tests__/zip.test.ts`

**Interfaces — Produces:** `createStreamingZip` gains an optional final options argument `{ streamFactory?: (file: File) => ReadableStream<Uint8Array> }`. When provided, per-file input streams come from the factory instead of the internal `file.stream()`-based sources (`zip.ts:296,318`). All existing call sites compile unchanged.

- [ ] **Step 1: Write the failing test** — read `zip.test.ts` first and follow its existing helpers for building test Files and consuming streams. Add:

```ts
it('uses the injected streamFactory instead of file.stream()', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.bin');
    let factoryCalls = 0;
    const factory = (f: File) => {
        factoryCalls++;
        return new Blob([new Uint8Array([1, 2, 3, 4])]).stream() as ReadableStream<Uint8Array>;
    };
    const withFactory = await collectStreamBytes(createStreamingZip([file], { streamFactory: factory }).stream);
    const without = await collectStreamBytes(createStreamingZip([file]).stream);
    expect(factoryCalls).toBe(1);
    expect(withFactory).toEqual(without); // byte-identical archives
});
```

(Adapt the exact `createStreamingZip` return-shape access — read its current signature first; if it returns the stream directly, drop `.stream`. If `zip.test.ts` has no `collectStreamBytes` helper, write one that reads a `ReadableStream<Uint8Array>` to a single `Uint8Array`. If zip output embeds mtimes, pass the same `lastModified` to both runs.)

- [ ] **Step 2:** Run — FAIL (unexpected argument / factory unused).
- [ ] **Step 3:** Thread the options object through `createStreamingZip`; where it currently constructs each entry's input stream, use `opts?.streamFactory?.(file) ?? <existing source>`.
- [ ] **Step 4:** Run `zip.test.ts` + full suite + typecheck — green.
- [ ] **Step 5:** Commit: `refactor(frontend): allow injected per-file streams in createStreamingZip`

---

### Task 3: `PartStore` — interface, `MemoryPartStore`, `OpfsPartStore`

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/part-store.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/part-store.test.ts`

**Interfaces — Produces:** exactly the `PartStore` interface + `PartStoreQuotaError` from the contract block, plus `export class MemoryPartStore implements PartStore` (constructor: `new MemoryPartStore(opts?: { quotaBytes?: number })`) and `export class OpfsPartStore implements PartStore` (constructor: `new OpfsPartStore(fileId: string)`; static `OpfsPartStore.gc(liveFileIds: Set<string>): Promise<void>` deletes `uploads/<id>` dirs not in the set — GC *callers* add the lock check in Task 12).

**Key semantics (from spec [R4][R11]):** `stagePart` writes to a temp name (`part-<n>.tmp`), verifies every write's returned byte count, then commits by rename to `part-<n>.bin`; only committed parts appear in `listParts`/`readPart`. A throw mid-stage leaves no committed part and removes the temp. Quota failures throw `PartStoreQuotaError`. OPFS: acquire `createSyncAccessHandle`, `flush()` + `close()` before commit; `readPart` uses `getFile()` only on committed entries.

- [ ] **Step 1: Write the failing tests** (MemoryPartStore carries the contract; OPFS is covered in Task 16's real browser):

```ts
import { describe, expect, it } from 'vitest';
import { MemoryPartStore, PartStoreQuotaError } from '../part-store';

async function* chunks(...arrays: Uint8Array[]) { for (const a of arrays) yield a; }

describe('MemoryPartStore', () => {
    it('stages, lists, reads, deletes a part', async () => {
        const s = new MemoryPartStore();
        const { size } = await s.stagePart(1, chunks(new Uint8Array([1, 2]), new Uint8Array([3])));
        expect(size).toBe(3);
        expect(await s.listParts()).toEqual([{ partNumber: 1, size: 3 }]);
        expect(new Uint8Array(await (await s.readPart(1)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        await s.deletePart(1);
        expect(await s.listParts()).toEqual([]);
    });
    it('an aborted stage leaves no committed part', async () => {
        const s = new MemoryPartStore();
        async function* failing() { yield new Uint8Array([1]); throw new Error('source died'); }
        await expect(s.stagePart(1, failing())).rejects.toThrow('source died');
        expect(await s.listParts()).toEqual([]);
    });
    it('throws typed quota error and stages nothing', async () => {
        const s = new MemoryPartStore({ quotaBytes: 2 });
        await expect(s.stagePart(1, chunks(new Uint8Array([1, 2, 3])))).rejects.toBeInstanceOf(PartStoreQuotaError);
        expect(await s.listParts()).toEqual([]);
    });
    it('re-staging the same part number replaces it', async () => {
        const s = new MemoryPartStore();
        await s.stagePart(1, chunks(new Uint8Array([9])));
        await s.stagePart(1, chunks(new Uint8Array([7, 8])));
        expect(await s.listParts()).toEqual([{ partNumber: 1, size: 2 }]);
    });
});
```

- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement both stores (Memory: `Map<number, Uint8Array>` committed + staging buffer; quota check across staged+committed bytes; OPFS per the semantics above, feature-detected imports only — no top-level `navigator.storage` access so the module stays importable under happy-dom). **Step 4:** Run + typecheck — green. **Step 5:** Commit: `feat(frontend): add PartStore with OPFS and in-memory implementations`

---

### Task 4: Engine state store (`state.ts`)

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/state.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/state.test.ts`

**Interfaces — Produces:** `openEngineState(): Promise<EngineStateStore>` plus the record types from the contract block (export them from `state.ts`). DB `bolter-upload-engine` v1, object stores: `leases` (keyPath `fileId`), `envelopes` (keyPath `fileId`), `checkpoints` (keyPath `fileId`), `parts` (keyPath `[fileId, partNumber]`).

**Test setup:** copy the fake-indexeddb pattern from `apps/frontend/src/lib/__tests__/upload-state.test.ts` (read it first — reuse its import/reset approach; delete DB `bolter-upload-engine` between tests).

- [ ] **Step 1: Write the failing tests** — cover: lease round-trip; envelope round-trip preserving every field of `CompletionEnvelope`; checkpoint overwrite (put twice, get returns latest); `getParts` sorted by partNumber with compound keys under two different fileIds isolated; `listLeases` returns all; `clearUpload` removes all four record types for one fileId and leaves others intact. Write them concretely in the style of Task 3 (construct full record literals; assert deep equality).
- [ ] **Step 2:** FAIL. **Step 3:** Implement with plain `indexedDB.open` + promisified transactions (follow `upload-state.ts`'s promisify helpers as the house pattern — read it; do not import it). **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add engine IndexedDB state store (bolter-upload-engine)`

---

### Task 5: Producers (`producer.ts`)

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/producer.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/producer.test.ts`

**Interfaces — Produces:**

```ts
export const PRODUCER_CHUNK_RECORDS = 64; // 64 × 65,536 = 4 MiB plaintext per read
export interface ProducerChunk { bytes: Uint8Array; sourceOffset: number; } // offset BEFORE this chunk
export function createSliceProducer(source: Blob, opts?: { startOffset?: number; chunkBytes?: number }): AsyncGenerator<ProducerChunk>;
export function createZipProducer(files: File[], names: string[], opts?: { chunkBytes?: number }): AsyncGenerator<ProducerChunk>; // wraps createStreamingZip with slice-backed streamFactory (Task 2); NOT restartable mid-stream — zip resume is crash-window only
```

**Semantics:** `createSliceProducer` reads `source.slice(off, off + chunkBytes)` → `arrayBuffer()`, yields non-empty chunks only. EOF = short read. **Growth probe:** after a read returns exactly to declared `source.size`, attempt one further slice read past the declared size; if it returns bytes, keep reading until a short read (covers iOS lazy-transcode growth [R1]). The slice-backed `streamFactory` for the zip producer pulls each file with the same slice loop (chunk size may be smaller internally; still no `file.stream()`).

- [ ] **Step 1: Failing tests** (build Blobs from Uint8Arrays; collect all yields):
  - chunking: an 10-byte blob with `chunkBytes: 4` yields sizes `[4, 4, 2]` with `sourceOffset` `[0, 4, 8]`.
  - empty blob yields nothing.
  - `startOffset` mid-source resumes exactly (offset 4 on the 10-byte blob → sizes `[4, 2]`).
  - empty-chunk filter: a zip producer over a zero-byte file still yields only non-empty chunks (zip headers exist; assert every yielded `bytes.length > 0`).
  - zip producer byte-equivalence: `createZipProducer([f], ['a.bin'])` concatenated equals `createStreamingZip([f])` collected (reuse Task 2's helper approach).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add slice-only producers with record-aligned chunking`

---

### Task 6: Stager (`stager.ts`)

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/stager.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/stager.test.ts`

**Interfaces — Produces:**

```ts
export interface StagerOpts {
    fileId: string;
    partSize: number; // payload bytes per part (already effective/record-aligned when encrypted)
    totalParts: number; // allocated part count — hard cap; final part absorbs overflow [R1]
    windowSize: number; // max staged-not-yet-uploaded parts
    store: PartStore;
    state: EngineStateStore;
    encrypt?: TransformStream<Uint8Array, Uint8Array>; // createEncryptionStream(keychain) when encrypted
    checkpointOf(sourceOffset: number, partNumber: number, eof: boolean): ProducerCheckpoint;
    onPartStaged(partNumber: number, size: number): void; // wakes uploaders
    partReleased: () => Promise<void>; // resolves when a window slot frees
}
export function runStager(producer: AsyncGenerator<ProducerChunk>, opts: StagerOpts): Promise<{ partsProduced: number; actualSize: number }>;
```

**Semantics:** pipe producer (through `encrypt` when present) and cut the output at `partSize` boundaries into `store.stagePart` calls; part `totalParts` absorbs all remaining bytes (growth) [R1]; short input = fewer parts (shrink). After each committed stage: `state.putPart({ staged: true, uploaded: false, ... })` **then** `state.putCheckpoint(checkpointOf(...))` — checkpoint always describes the *next* part to produce [R4][R5]. When staged-unuploaded count reaches `windowSize`, await `partReleased()` before staging more (backpressure).

- [ ] **Step 1: Failing tests** (MemoryPartStore + a fake `EngineStateStore` backed by Maps — write a `fakeState()` helper in the test file; unencrypted first):
  - cuts exact boundaries: 10 bytes, partSize 4, totalParts 3 → parts sized `[4, 4, 2]`, checkpoints after each with `nextPartNumber` `[2, 3, 4]` and `eofReached` true on the last.
  - growth absorption: 12 bytes declared but totalParts 2, partSize 4 → parts `[4, 8]` (final part absorbs).
  - backpressure: windowSize 1 and a `partReleased` gate the test controls — assert the second `stagePart` does not begin until the gate opens (track call order with the fake store).
  - encrypted path: pass a real `createEncryptionStream` (from `@/lib/crypto`, keychain built the way `crypto.test.ts` does — read it) with partSize = one encrypted record (65,553); assert each staged non-final part is exactly 65,553 bytes and content differs from plaintext.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add rolling-window stager with durable checkpoints`

---

### Task 7: Uploader (`uploader.ts`)

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/uploader.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/uploader.test.ts` (reuse fakes from `apps/frontend/src/lib/__tests__/upload-xhr-fake.ts` — read it first; extend it there only if additive)

**Interfaces — Produces:**

```ts
export interface UploaderOpts {
    urls: string[]; // index 0 = part 1
    maxConcurrent: number;
    store: PartStore; state: EngineStateStore; fileId: string;
    uploadPart: EngineDeps['uploadPart'];
    refreshUrls(): Promise<string[]>;
    now(): number; isOnline(): boolean;
    stallMs?: number; // default 60_000 wall-clock without progress
    maxAttemptsPerPart?: number; // default 6
    retryDelayMs(attempt: number): number; // from upload-shared (Task 1)
    onProgress(totalBytesSent: number): void; onRetry(): void;
    signal: AbortSignal;
}
export function runUploaders(partsToUpload: () => Promise<{ partNumber: number; size: number } | null>, opts: UploaderOpts): Promise<Map<number, string>>; // partNumber → ETag; pull-based: null = no more parts
```

**Semantics:** N workers pull parts, `store.readPart` → `uploadPart` with an AbortSignal; **stall = `now()` delta since last progress > stallMs** (check on progress events and a coarse interval; never trust timer cadence alone [R14]); stall/failure → abort attempt, if `isRetryableError` and attempts < max: wait `retryDelayMs(attempt)`, if `!isOnline()` also wait for connectivity (poll `isOnline()` at 1s wall-clock intervals), on 403-style URL expiry call `refreshUrls()` once per part, retry (byte-identical: re-`readPart`). Success → `state.putPart({ uploaded: true, etag, ... })` then `store.deletePart` **only after** the put resolves [R11], then release a window slot.

- [ ] **Step 1: Failing tests** with fake `uploadPart`:
  - happy path: 3 parts, concurrency 2 → all etags collected, parts deleted after upload, `putPart` uploaded-record precedes `deletePart` (record call order).
  - retry byte-identity: first attempt fails retryably; assert `readPart` called twice for that part and both bodies byte-equal.
  - stall: a `uploadPart` fake that reports progress once then hangs; drive a fake `now()` forward past `stallMs`; assert abort + retry. (Design `uploader.ts` to accept an injectable `setTimeoutFn` if needed for deterministic testing — add it to `UploaderOpts` as optional.)
  - offline gating: `isOnline()` false after a failure → no retry until it flips true (fake clock).
  - non-retryable error rejects the whole run and aborts the signal to other workers.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add pull-based concurrent uploader with wall-clock stall detection`

---

### Task 8: Validation + completion (`completion.ts`)

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/completion.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/completion.test.ts`

**Interfaces — Produces:**

```ts
export function validatePartSequence(parts: { partNumber: number; size: number }[], effectivePartSize: number): void;
// Throws Error with message starting 'part sequence invalid' unless: partNumbers are exactly 1..k;
// every part below k has size === effectivePartSize AND >= 5_242_880; part k may be any size >= 1 (may exceed effectivePartSize) [R15].
export function finalizeUpload(envelope: CompletionEnvelope, etags: Map<number, string>, sizes: Map<number, number>, effectivePartSize: number, deps: Pick<EngineDeps, 'completeUpload' | 'state' | 'store'>): Promise<void>;
// validate → completeUpload → store.destroy() → state.clearUpload(envelope.fileId) — strictly in that order.
```

- [ ] **Step 1: Failing tests:** gap (parts 1,3) throws; duplicate throws; undersized non-trailing throws; oversized trailing part passes; single small part `[1]` passes; happy path calls `completeUpload` before `destroy` before `clearUpload` (record order); a `completeUpload` rejection leaves store + state intact.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add combined part-sequence validation and ordered finalization`

---

### Task 9: `runEngine` assembly (`engine.ts`)

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/engine.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/engine.test.ts`

**Interfaces:** Consumes Tasks 3–8 exactly as specified; Produces `runEngine` per the contract block.

**Semantics:** write lease (with `uploadToken`) → write envelope → build producer from `job.source` (file/blob → `createSliceProducer`; zip → `createZipProducer`) starting at the persisted checkpoint's `sourceOffset` when resuming (file/blob only) → run stager + uploaders concurrently (stager's `onPartStaged` feeds the uploader pull queue; uploader completion releases window slots) → `finalizeUpload`. Cancel signal: abort uploaders, stop stager, call `deps.abortUpload(fileId, uploadToken)`, emit `{ type: 'cancelled' }`, then `store.destroy()` + `state.clearUpload` [R6]. Emit `progress` from uploader bytes; `error` with `retryable` flag on failure (state left intact for resume when retryable).

- [ ] **Step 1: Failing tests** (all fakes; single-file source of 12 bytes, partSize 4, totalParts 3):
  - happy path end-to-end: 3 parts uploaded, `completeUpload` called with contiguous 1..3, `done` event with `actualSize: 12`, state cleared.
  - cancel mid-flight: abort after first part uploads → `abortUpload` called with the job's `uploadToken`, `cancelled` emitted, store destroyed.
  - retryable failure preserves state: uploader exhausts attempts on part 2 → `error{retryable:true}`, lease/checkpoint/parts still present, staged part 2 still readable.
  - encrypted job: assert bytes given to `uploadPart` differ from source plaintext and non-final parts are 65,553-multiples.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): assemble worker upload engine pipeline`

---

### Task 10: Resume decision tree (`resume.ts`)

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/resume.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/resume.test.ts`

**Interfaces — Produces:**

```ts
export type ResumePlan =
    | { action: 'replay-complete' } // envelope + full contiguous etag list [R7]
    | { action: 'finish-staged' } // all remaining bytes staged; no source needed
    | { action: 'need-source'; kind: 'single' | 'multi' } // single → re-pick/handle; multi → start-fresh only
    | { action: 'unrecoverable' }; // no lease/envelope
export function planResume(lease: EngineLease | undefined, envelope: CompletionEnvelope | undefined, checkpoint: ProducerCheckpoint | undefined, parts: EnginePartRecord[]): ResumePlan;
export function executeResume(fileId: string, deps: EngineDeps, cancel: AbortSignal): Promise<EngineResult>; // loads state, plans, runs (replay path calls completeUpload directly with persisted etags)
```

**Decision rules (spec order):** (1) envelope present AND parts 1..k all `uploaded` with etags AND checkpoint `eofReached && finalRecordEmitted` (or unencrypted eof) → `replay-complete`. (2) checkpoint eof reached AND every produced part is `staged` (uploaded or not) → `finish-staged`. (3) lease+envelope present but production incomplete → `need-source` with `kind` from `envelope.manifest.length > 1 ? 'multi' : 'single'`. (4) otherwise `unrecoverable`.

- [ ] **Step 1: Failing tests:** one per branch with concrete record literals, plus: gap in uploaded etags → NOT replay (falls to finish-staged/need-source); multi-file with eof + all staged → `finish-staged` (the crash-window promise).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add engine resume decision tree with completion replay`

---

### Task 11: `protocol.ts`, `client.ts`, `engine.worker.ts`

**Files:**
- Create: `apps/frontend/src/lib/upload-engine/protocol.ts` (the contract block verbatim), `apps/frontend/src/lib/upload-engine/client.ts`, `apps/frontend/src/lib/upload-engine/engine.worker.ts`
- Test: `apps/frontend/src/lib/upload-engine/__tests__/client.test.ts`

**Interfaces — Produces:**

```ts
// client.ts
export interface EngineEligibility { eligible: boolean; reason?: string; }
export function probeEligibility(): Promise<EngineEligibility>; // worker spawn → getDirectory → 1-byte sync-handle round trip → estimate; localStorage['bolter:upload-engine']==='off' → { eligible:false, reason:'kill-switch' }
export interface EngineClientHooks { onProgress(sent: number, total: number): void; onRetry(): void; }
export function runEngineInWorker(job: EngineJob, envelope: CompletionEnvelope, hooks: EngineClientHooks, canceller: { onCancel(cb: () => void): void }): Promise<EngineResult>;
// Design client.ts so worker creation is injectable: export a module-level `let workerFactory = () => new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })`
// plus `export function setWorkerFactory(f: () => Worker)` for tests. The `new Worker(new URL(...))` literal MUST stay in client.ts for Vite static analysis [R17].
```

**Semantics:** client relays `online`/`offline` window events as `connectivity` messages; forwards `progress`/`retry` to hooks; resolves on `done`, rejects on `error`. **Cancel escalation [R6]:** on cancel, post `{type:'cancel'}`; if no `cancelled` ack within 10s wall-clock, `worker.terminate()` and perform the authenticated abort from the main thread (call the same endpoint helper the worker uses — import `abortMultipartUpload`-equivalent logic via a small exported helper in client.ts that POSTs `/upload/abort/:id` with `uploadToken`). Worker entry: `self.onmessage` dispatches `start`/`resume`/`cancel`/`connectivity` into `runEngine`/`executeResume` with real deps (OpfsPartStore, `openEngineState()`, XHR `uploadPart`, fetch-based API calls to `API_BASE_URL`).

- [ ] **Step 1: Failing tests** (fake Worker via `setWorkerFactory` — a `FakeWorker` class in the test file implementing `postMessage`/`terminate`/`onmessage`):
  - probe honors kill switch (set `localStorage['bolter:upload-engine']='off'` → ineligible, reason `kill-switch`).
  - `runEngineInWorker` resolves with the `done` payload and forwards progress events to hooks.
  - `error{retryable:false}` from worker → rejection.
  - cancel ack path: cancel → FakeWorker replies `cancelled` → promise rejects with a cancellation error, no terminate.
  - cancel escalation: FakeWorker never acks → after fake 10s, `terminate()` called and main-thread abort helper invoked (spy on fetch).
- [ ] **Step 2:** FAIL. **Step 3:** Implement all three files. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add engine worker entry, client facade, and cancel escalation`

---

### Task 12: Delegation in `uploadFiles` + engine resume routing + GC

**Files:**
- Modify: `apps/frontend/src/lib/api.ts` (top of `uploadFiles`, ~line 925; `resumeUpload`, ~line 1519 — routing only, legacy body untouched)
- Modify: `apps/frontend/src/pages/Home.tsx` (resume card: add the "Finish upload — no file selection needed" state; wire engine resume)
- Test: `apps/frontend/src/lib/upload-engine/__tests__/delegation.test.ts`

**Semantics:** at the top of `uploadFiles`, when `totalSize > UPLOAD_LIMITS.MULTIPART_THRESHOLD` and `await probeEligibility()` is eligible: run the engine path — allocation (`/upload/url`) and preflight stay as today (reuse the existing code by extracting the allocation block into a function *only if it needs no behavioral change*; otherwise duplicate the two fetch calls inside a new `uploadViaEngine` helper in `client.ts` — do NOT restructure the legacy body), build `EngineJob` + `CompletionEnvelope` (metadata/authKey exactly as the legacy path computes them — read the legacy construction around `api.ts:1248-1310` and reuse its helpers), then `runEngineInWorker`. Ineligible → fall through to the untouched legacy body. On app startup (`client.ts` export `engineStartupMaintenance()`, called from `Home.tsx` effect): for each engine lease, offer resume; run `OpfsPartStore.gc(liveIds)` guarded by `navigator.locks.request('upload:'+id, { ifAvailable: true }, ...)` — skip dirs whose lock is held [R12]. `resumeUpload` routing: if the id has an engine lease → `executeResume` path; else legacy.

- [ ] **Step 1: Failing tests:** with `setWorkerFactory` faked + fetch spied: eligible+large → worker receives `start` with a job whose `partUrls`/`partSize` come from the mocked `/upload/url` response and envelope matches mocked metadata; ineligible → legacy path invoked (spy: the legacy code path is reached — assert via the first legacy-only fetch it makes); small file → legacy regardless.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** New + full suite green (`api-upload-stream/sliced/resume` tests must still pass untouched) + typecheck. **Step 5:** Commit: `feat(frontend): route eligible multipart uploads through the worker engine`

---

### Task 13: Persisted handles (data model + DropZone + picker)

**Files:**
- Modify: `apps/frontend/src/stores/app.ts` (`FileItem`, line ~7: add optional `handle?: FileSystemFileHandle`), `apps/frontend/src/components/DropZone.tsx`, `apps/frontend/src/lib/upload-engine/state.ts` (lease gains optional `handles?: FileSystemFileHandle[]` — IndexedDB can store handles), `apps/frontend/src/pages/Home.tsx` (one-click resume button when a handle exists)
- Test: `apps/frontend/src/lib/upload-engine/__tests__/handles.test.ts`

**Semantics [R13]:** DropZone captures `item.getAsFileSystemHandle?.()` for **top-level dropped files only** (alongside the existing `webkitGetAsEntry` at `DropZone.tsx:125`); folder-traversal files and `<input>` files stay handleless. Click-to-browse uses `showOpenFilePicker` when `'showOpenFilePicker' in window` (multiple: true), falling back to the existing input. One-click resume: `handle.requestPermission({ mode: 'read' })` → `getFile()` → verify `name`/`size`/`lastModified` against the lease's envelope manifest and `computeContentFingerprint` (exported from `api.ts` — export it if currently private) → feed as the resume source.

- [ ] **Step 1: Failing tests:** verification helper `verifyHandleFile(file, expected: { name; size; lastModified; fingerprint })` (new export in `resume.ts`): mismatch on any field rejects; match passes (fake fingerprint fn injectable). DropZone: simulate a drop item exposing `getAsFileSystemHandle` → `FileItem.handle` populated; folder-entry path → no handle.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): capture and verify persisted file handles for one-click resume`

---

### Task 14: Wake lock, Web Locks, storage.persist

**Files:**
- Create: `apps/frontend/src/lib/upload-lifecycle.ts`
- Modify: `apps/frontend/src/lib/api.ts` (`uploadFiles`: wrap both engine and legacy paths), `apps/frontend/src/lib/upload-engine/engine.worker.ts` (hold Web Lock for job lifetime)
- Test: `apps/frontend/src/lib/__tests__/upload-lifecycle.test.ts`

**Interfaces — Produces:**

```ts
export function withUploadLifecycle<T>(fileId: string, run: () => Promise<T>): Promise<T>;
// Acquires screen wake lock (best-effort, re-acquire on visibilitychange), requests navigator.storage.persist()
// once per session, and wraps `run`. Releases wake lock on settle. All APIs feature-detected; absence is a no-op.
export function acquireUploadLock<T>(fileId: string, run: () => Promise<T>): Promise<T>;
// navigator.locks.request('upload:'+fileId, { ifAvailable: true }, ...) — held for the FULL duration of run [R12];
// throws UploadLockBusyError if unavailable. Worker uses the same helper (locks API exists in workers).
export class UploadLockBusyError extends Error {}
```

- [ ] **Step 1: Failing tests** (happy-dom lacks these APIs — stub `navigator.wakeLock`/`navigator.locks`/`navigator.storage` on `globalThis` per test): wake lock acquired + released on success and on throw; re-acquire on visibilitychange while running; `persist()` called at most once across two runs; lock busy → `UploadLockBusyError` without invoking `run`; missing APIs → `run` still executes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; wire `withUploadLifecycle` around `uploadFiles`' body and `acquireUploadLock` into `engine.worker.ts` job handling + the GC guard from Task 12. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add upload lifecycle (wake lock, web locks, storage.persist)`

---

### Task 15: Telemetry

**Files:**
- Modify: `apps/frontend/src/lib/plausible.ts` (extend types), `apps/frontend/src/lib/upload-engine/client.ts` (emission points), `apps/frontend/src/pages/Home.tsx` (`trackUpload` gains `engine` prop)
- Test: extend `apps/frontend/src/lib/__tests__/analytics.test.ts`

**Interfaces — Produces:** `trackUploadAttempt(props: { engine: 'worker' | 'legacy'; reason?: string; attemptId: string })`, `trackEngineEvent(props: { attemptId: string; event: 'failure' | 'resume' | 'cancel' | 'replay' | 'persist-result'; detail?: string })` in `plausible.ts`, following its existing dual-provider fan-out pattern (read the file; wrap each provider independently). `attemptId`: 13-char lowercase alphanumeric nanoid with `ua_` prefix — no file identifiers [R16]. Existing `trackUpload` type gains optional `engine`.

- [ ] **Step 1: Failing tests:** follow `analytics.test.ts` fakes — attempt event carries engine + reason; engine event carries attemptId; no event includes fileId (assert payload keys).
- [ ] **Step 2:** FAIL. **Step 3:** Implement + emit: attempt at delegation decision (both outcomes), failure/cancel/replay from client relay, persist-result from Task 14 hook. **Step 4:** Green + typecheck. **Step 5:** Commit: `feat(frontend): add engine telemetry events`

---

### Task 16: Playwright real-browser suite

**Files:**
- Create: `apps/frontend/playwright.config.ts`, `apps/frontend/e2e/upload-engine.spec.ts`, `apps/frontend/e2e/helpers.ts`
- Modify: `apps/frontend/package.json` (devDep `@playwright/test`; scripts `"e2e": "playwright test"`)

**Scope [R17]:** These tests exercise browser reality that fakes cannot: OPFS sync handles, worker chunk loading in the production build, structured clone, reload recovery. Backend is **not** required: the spec file mocks network at the page level (`page.route` for `API_BASE_URL` + S3 PUT URLs, returning canned allocation/complete responses and accepting PUTs). Config: `webServer: { command: 'bunx vite preview --port 4173', cwd: '.' }` with a prior `vite build`; chromium project only.

- [ ] **Step 1:** Install: `cd apps/frontend && bun add -d @playwright/test && bunx playwright install chromium` (if the browser download fails in this environment, still commit config+specs and note it in the final report — do not delete the suite).
- [ ] **Step 2: Write the specs** (each `test()` concrete):
  - engine path smoke: 150MB generated payload (`helpers.ts` makes a File via `new File([new Uint8Array(...)], ...)` in page context) uploads through the worker (assert PUTs hit the mocked part URLs with correct sizes; assert completion body has contiguous parts).
  - reload mid-upload → resume: intercept after part 1 PUT, `page.reload()`, assert the resume flow completes remaining parts without re-producing part 1 (mock records PUT counts per URL).
  - kill switch: set `localStorage['bolter:upload-engine']='off'` before upload → assert no worker requests (engine telemetry attempt reports legacy).
  - OPFS cleanup: after successful upload, evaluate `navigator.storage.getDirectory()` in page context and assert no `uploads/` children remain.
- [ ] **Step 3:** Run `bunx playwright test`; iterate until green (or document environment blockage precisely).
- [ ] **Step 4:** Commit: `test(frontend): add Playwright suite for worker engine against production build`

---

### Task 17: Docs

**Files:**
- Modify: `AGENTS.md` (Resilient Uploads section: engine architecture, kill switch, fallback, new module map; Key Frontend Components list), `README.md` (features + configuration parity with AGENTS.md), `SECURITY.md` (ciphertext-at-rest staging invariant: "For encrypted uploads the engine stages ciphertext only; plaintext never exists at rest — encryption runs producer-side before bytes reach OPFS.")

- [ ] **Step 1:** Read all three files; make the additions match the shipped behavior exactly (including `bolter:upload-engine` kill-switch key and the four resume branches). Keep AGENTS.md/README.md in sync per their maintenance note.
- [ ] **Step 2:** `bun run check` at root (formatting).
- [ ] **Step 3:** Commit: `docs: document worker+OPFS upload engine, kill switch, and staging security model`

---

## Self-review record

- **Spec coverage:** eligibility probe → T11/T12; separate DB → T4; slice-only producers + growth probe → T5; zip injection → T2/T5; stager window + checkpoint + merge-drop → T6; wall-clock stall + offline relay → T7/T11; combined-sequence validation → T8; lease/envelope ordering + cancel/uploadToken → T9/T11; resume tree incl. replay → T10; delegation + GC-with-lock → T12; handles → T13; wake lock/web locks/persist → T14; telemetry breadth → T15; Playwright → T16; docs → T17. No uncovered spec section.
- **Type consistency:** all cross-task names come from the "Shared interfaces" block; tasks were checked against it.
- **Known intentional simplifications:** engine resume for `need-source` single-file reuses the handle/fingerprint flow (T13) rather than re-implementing legacy re-pick UI; zip resume is crash-window only (producer not restartable) — matches spec scope.
