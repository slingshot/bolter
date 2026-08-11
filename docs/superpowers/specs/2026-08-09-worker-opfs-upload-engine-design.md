# Worker + OPFS Resilient Upload Engine — Design Spec

**Date:** 2026-08-09
**Status:** Awaiting review
**Reviewed by:** Codex CLI (2026-08-09, adversarial design review: 6 blockers / 10 majors / 1 minor — all incorporated, marked `[R#]` where load-bearing)

## Problem

The upload pipeline (`apps/frontend/src/lib/api.ts`, ~4,050 lines) runs entirely on the main thread and reads live `File` objects lazily at upload time. Nearly every hard-won defense in the codebase traces to those two facts:

- Multi-layer WebKit empty-chunk filtering and iOS HEIC/HEVC transcode-drift detection exist because the byte source is unstable while being read.
- A second, Safari-only engine (`uploadMultipartSliced`) exists to avoid `file.stream()` bugs — but cannot serve encrypted uploads, which still ride the buggy stream path.
- Stall-detection timers run on the page's event loop, which Chrome throttles to ~1/min after 5 minutes in a background tab — the *normal* state for a large upload.
- Resume requires the user to manually re-locate and re-pick the file.
- Multi-file (zipped) uploads are not resumable at all: the zip stream cannot be re-wound after a reload.

## Solution overview

A new upload engine runs in a dedicated Web Worker with an OPFS (Origin Private File System) staged-part store. Staging decouples *producing* bytes from *uploading* them: parts are cut from materialized bytes, so retries are byte-identical, part sizes are exact before any PUT, transcode drift resolves before it can corrupt a part, and stall detection runs off the main thread. Timer throttling is reduced but not eliminated (pages can be frozen with their workers), so **correctness never depends on timer fidelity** — all stall/backoff logic uses wall-clock deltas.

## Decisions (locked 2026-08-09)

| Decision | Choice | Rationale / rejected alternative |
|---|---|---|
| Engine strategy | Fresh unified engine; both legacy multipart paths superseded *as the default* (they remain reachable via fallback) | Porting existing code into the worker would carefully preserve symptom-filtering the engine makes unnecessary |
| Risk posture | Legacy pipeline retained **untouched** as automatic fallback + `localStorage` kill switch; deleted later on telemetry evidence | Battle-tested code; clean replacement offered no safety net |
| Multi-file resume | Crash-window only: staged parts survive reload; no multi-file re-pick flow | Full re-pick resume requires deterministic zip regeneration — new bug class |
| Multi-file format | **Zip-at-upload retained** | Concatenated format + zip-on-download (the "legacy" format) was evaluated: it simplifies the engine and unlocks full multi-file resume with zero backend changes, but loses the zero-JS direct-S3 download for unencrypted multi-file (`Download.tsx:365`) and makes every recipient re-zip |
| Extras | Persisted `FileSystemFileHandle` one-click resume (Chromium), Screen Wake Lock, Web Locks per uploadId, `storage.persist()` | All small; selected explicitly |
| Out of scope | Background Fetch, WASM per-part MD5, server-side kill-switch config, any behavioral change to the legacy pipeline | Background Fetch (Chromium-only) conflicts with pre-signed URL expiry; MD5 is a nice-to-have integrity upgrade for later |

## Architecture

New directory `apps/frontend/src/lib/upload-engine/`:

| Unit | Purpose | Depends on |
|---|---|---|
| `client.ts` | Main-thread facade: eligibility probe, worker spawn, typed message relay, connectivity relay, wake lock, cancel escalation. The `new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })` constructor must live here for Vite's static analysis [R17]. Returns "ineligible" → caller falls through to legacy. | `protocol.ts` |
| `engine.worker.ts` | Worker entry; wires real deps (OPFS store, real XHR, real API) into `runEngine`. | `engine.ts`, `part-store.ts`, `state.ts` |
| `engine.ts` | `runEngine(deps)` — transport-agnostic pipeline core (producer → stager → uploaders → completion). Unit-testable with fake deps (established pattern: `stream-saver.test.ts` fake workers). | `upload-shared.ts`, `crypto.ts` |
| `part-store.ts` | `PartStore` interface + `OpfsPartStore` + `MemoryPartStore` (tests). | — |
| `state.ts` | Engine persistence: **separate IndexedDB database** (`bolter-upload-engine`) [R9]. | — |
| `protocol.ts` | Typed client↔worker messages: job, progress, connectivity, cancel (acknowledged), error, done. | — |

**Why a separate IndexedDB database:** old deployed bundles must never observe engine records. The legacy store's version field is value-level only; its readers accept unknown versions and would surface engine state in the legacy resume UI. Bumping the shared DB's version instead would throw `VersionError` in still-open old tabs. The engine never writes the legacy DB (`upload-state.ts`); the legacy path keeps using it unchanged.

**Worker-safe shared helpers:** helpers the worker needs (`getConcurrentUploads`, retry classification, backoff) are extracted to `apps/frontend/src/lib/upload-shared.ts` with no `window`/`document` references — e.g. `waitForOnline` (`api.ts:75`) registers listeners on `window` and cannot be imported into a worker [R8, R14]. `api.ts` re-exports them so existing imports don't churn.

**Boundary facts relied upon:** `File` structured-clones as a cheap handle (no byte copy); the encryption secret crosses as `secretKeyB64` and is re-derived in-worker via existing `crypto.ts` helpers; XHR upload-progress events work in dedicated workers; IndexedDB works in workers.

## Delegation point

Branch at the **top** of `uploadFiles` — before zip construction, encryption-stream creation, and preflight [R8] — not at the `uploadMultipart*` call sites (by then expensive main-thread zip work is done and an unused stream exists). Eligible + multipart-sized (total size > `UPLOAD_LIMITS.MULTIPART_THRESHOLD`, same gate as today) → `client.ts` owns allocation-onward; everything else falls through to the untouched legacy body. `resumeUpload` routes by which database holds the persisted record (engine DB vs legacy DB); each engine resumes only its own uploads.

## Pipeline design

### Producers (slice-only; `file.stream()` is retired inside the engine)

- Reads happen in **bounded, record-aligned chunks** (e.g. 4 MiB = 64 × 65,536-byte plaintext records), never whole-part `arrayBuffer()`: `createEncryptionStream` re-slices its remaining buffer once per 64 KiB record (`crypto.ts:302-310`), so part-sized input chunks cause near-quadratic copying [R2]. Prefer feeding bounded chunks over refactoring the transform.
- **Single file:** sequential `slice()` reads.
- **Multi-file, large:** client-zip runs *in the worker*, fed **caller-owned slice-backed streams**. `createStreamingZip` (`zip.ts:296,318`) currently builds its own `File.stream()` sources and must be refactored to accept injected per-file streams; existing callers keep current behavior [R10].
- **Multi-file, small:** the existing buffered JSZip DEFLATE blob is produced exactly as today (exact compressed size known before allocation), then ingested by the engine as a seekable blob source. No DEFLATE→STORE behavior change [R10].
- **Encrypted:** producer output → `createEncryptionStream` → staging. **Only ciphertext ever touches OPFS; plaintext never exists at rest** (see Security).

### Size drift [R1]

Allocation (`/upload/url`) stays on the main thread and fixes `numParts` from declared sizes *before* staging can measure anything; `/resume` cannot expand an allocation. The engine keeps both of today's behaviors: source **shrinks** → finish with fewer contiguous parts `1..k` (backend accepts); source **grows** → the final allocated part absorbs all excess (today's drain behavior, `api.ts:2384`), guarded by the S3 5 GiB per-part cap.

### Stager

Rolling window of (maxConcurrent + 2) staged parts; the producer pauses when the window is full. Parts cut at `getEffectivePartSize` boundaries (record-aligned when encrypted). The small-final-part **merge is dropped**: a small trailing part is legal on S3/R2, and fixed-part-size math keeps persisted resume state valid (the merge is why resume state gets invalidated today). Pre-completion validation checks the **combined** persisted+new sequence `1..k`: every part below `k` exactly effective-size and ≥ 5 MiB; only part `k` may be small or oversized [R15].

### Uploaders

N concurrent XHRs (N from `getConcurrentUploads`) sending staged parts as Blobs (`handle.getFile()` only after `flush()`+`close()`; the OPFS entry is retained until the uploaded+ETag record commits [R11]). Stall detection is rebuilt on wall-clock deltas so worker suspension cannot fire false stalls [R14]. Connectivity: the main thread relays `online`/`offline` events over the protocol (worker-side support for those events is uneven); the worker additionally infers offline from consecutive immediate XHR failures so a missed relay can never park the upload forever [R14].

### Completion

Same `/upload/complete` contract (contiguous parts, one-shot auth, idempotent authKey retry). On success: delete the OPFS directory, clear engine state.

## Persistence & crash consistency

OPFS, IndexedDB, and S3 cannot share a transaction, so the design names every durable transition and its recovery [R4]. Engine DB records per upload:

1. **Lease** — written durably *before* the OPFS directory is created [R12]: fileId, uploadId, `uploadToken` [R6], ownerToken, createdAt, engine version.
2. **Completion envelope** [R3] — persisted as soon as its inputs exist (post-allocation): the exact metadata payload for `/upload/complete`, auth material, zip filename, source manifest (names/sizes/types), expected size, `secretKeyB64` if encrypted. Per-part flags alone cannot reconstruct this — today's resume rebuilds metadata from the re-picked File (`api.ts:1776`), and a source-free resume has no File.
3. **Producer checkpoint** [R5] — one committed record: next part number, source/plaintext offset, next ECE record counter, EOF-reached and final-record-emitted flags. The encryptor's mandatory final record means part size alone cannot distinguish an in-progress part from the genuine last one. Production restarts only from this checkpoint, never from inferred state.
4. **Per-part records** — `{ partNumber, size, staged, uploaded, etag }` with explicit transitions: temp OPFS file → verified full write (check returned counts) → `flush()`/`close()` → commit rename → `staged` record → PUT → `uploaded`+ETag record → deferred part deletion. Startup reconciles OPFS against the DB: uncommitted temp files are deleted, committed-but-unrecorded parts re-verified by size or discarded, `staged`-but-missing parts re-produced from the checkpoint.

### Resume decision tree (evaluated in order)

1. Envelope present + full contiguous ETag list durable → **replay `/upload/complete` directly**. Idempotent via authKey; covers the lost-response state where `/resume` 404s because the backend already deleted multipart metadata after S3 completion (`upload.ts:939`) [R7].
2. All remaining bytes staged (any source type, including multi-file and Safari) → finalize with no re-pick: upload staged parts, complete. Resume card: "Finish upload — no file selection needed".
3. Single-file with unstaged remainder → persisted-handle one-click (`requestPermission()` → `getFile()` → verify `computeContentFingerprint` + name/size/mtime) where a handle exists; otherwise today's manual re-pick flow.
4. Multi-file with unstaged remainder → "Start fresh" only (crash-window scope).

### Garbage collection

Engine init deletes OPFS directories only for fileIds whose lease is absent or expired **and** whose `upload:<fileId>` Web Lock is acquirable — never in the window between lease write and first part record, never under an active holder [R12]. (Legacy expiry cleanup knows nothing about OPFS and is not extended; engine state is self-contained.)

## Cancellation & credentials

`uploadToken` is persisted in the lease and sent on `/upload/multipart/:id/resume` and `/upload/abort/:id` — the backend enforces it when configured, and it is absent from the legacy persistence today [R6]. Cancel is an **acknowledged protocol**: client posts cancel → worker aborts in-flight XHRs, performs the server-side abort, acks → client resolves. If no ack arrives within a timeout (worker crashed or suspended), the client terminates the worker and performs the authenticated abort itself from the main thread — preserving the guarantees of today's synchronous `Canceller.cancel()` [R6].

## Fallback, rollout, telemetry

- **Eligibility probe** per upload in `client.ts`: worker spawns → `navigator.storage.getDirectory()` → 1-byte sync-handle write/read round-trip → `storage.estimate()` covers the window (advisory only — quota can still fail later). Any failure, or `localStorage['bolter:upload-engine'] === 'off'`, → legacy path silently.
- **Mid-flight failures** (e.g. `QuotaExceededError` during staging) are typed recoverable failures surfacing as normal retryable upload errors into the resume machinery. No mid-upload engine switching.
- **Telemetry** must measure more than the success mix [R16]: privacy-safe events for attempt (engine + eligibility/fallback reason), engine failure (stage), resume outcome (tree branch), cancellation, completion replay, and `storage.persist()` result — correlated by a random per-attempt id, never a file identifier. `plausible.ts` types are extended; the existing `trackUpload` success event gains the engine property. This data is the evidence for eventually deleting the legacy path.

## Extras

- **Screen Wake Lock:** acquired in the shared `uploadFiles` lifecycle (main thread — benefits both engines), re-acquired on `visibilitychange`, released on settle. Best-effort only: it applies to visible documents and can be rejected or auto-released; nothing depends on it [R14].
- **Web Locks:** held around the *entire* upload/resume operation — no `ifAvailable` probe-then-release (TOCTOU) [R12]. Locks auto-release when the holder's agent dies, so the durable lease, not the lock, is the source of truth; the lock is coordination only.
- **Persisted handles** (Chromium progressive enhancement) [R13]: `FileItem` (`stores/app.ts:7`) gains an optional `handle`; DropZone captures `getAsFileSystemHandle()` for top-level dropped files only; folder-traversal files (re-wrapped `File` objects, `DropZone.tsx:78`) and plain `<input>` files are explicitly handleless; click-to-browse prefers `showOpenFilePicker` (secure context + user activation required) with `<input>` fallback.
- **`storage.persist()`** requested on first multipart upload; result recorded in telemetry. It changes eviction policy, not capacity.

## Security

- For encrypted uploads the engine stages **ciphertext only** — encryption happens producer-side, before bytes touch OPFS. The existing guarantee "plaintext never leaves the browser unencrypted" tightens to "plaintext never exists at rest." For unencrypted uploads, staged bytes are byte-identical to what the bucket receives.
- OPFS is origin-private (not user-visible); staged ciphertext is deleted on completion/abort and garbage-collected on lease expiry.
- `secretKeyB64` persistence in the engine DB matches the existing legacy persistence posture (already stored for resume today).
- SECURITY.md gains the ciphertext-at-rest invariant.

## Testing strategy

- **Unit (bun):** `runEngine` with fake deps — happy path, retry byte-identity, wall-clock stall detection, cancel ack + timeout escalation, shrink/grow size drift, encrypted checkpoint restart, envelope replay, combined-sequence validation, window backpressure, quota failure typing, OPFS↔DB reconciliation table, probe-failure → legacy delegation.
- **Real browser (Playwright, against the production build via `vite preview`)** [R17]: fakes cannot validate sync-handle locking, worker event delivery, structured-clone behavior, real quota errors, or production worker chunk loading. Cover: reload/worker-kill at each durable transition (post-stage, post-PUT, pre-complete, post-complete-with-lost-response → replay), two-tab resume race, quota exhaustion, cancel-vs-done race, kill switch → legacy.
- **Manual:** Chromium one-click handle resume; Safari (physical or simulator) encrypted multipart with no empty-chunk warnings; Safari private mode → silent legacy fallback; DevTools offline mid-part → pause/resume.

## Documentation impact

AGENTS.md and README.md (architecture: resilient uploads section, new module map, kill switch, telemetry), SECURITY.md (ciphertext-at-rest invariant).

## Implementation sequencing notes (input to the implementation plan, not a task list)

Dependency order: `upload-shared.ts` extraction + `zip.ts` injected-streams refactor first (existing tests must stay green) → `protocol.ts`/`part-store.ts` → `state.ts` → `engine.ts` core → `client.ts`/`engine.worker.ts` + delegation → resume tree + Home resume-card states + GC → extras → telemetry + docs. The detailed implementation plan is derived from this spec via the writing-plans process.
