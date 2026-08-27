# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Cursor, Copilot, etc.) when working with code in this repository. It is symlinked as `CLAUDE.md` for Claude Code compatibility.

> **Important**: At the end of any work session, update both `AGENTS.md` and `README.md` if your changes affect project documentation — architecture, commands, environment variables, API endpoints, features, or configuration. Keep these files in sync with the codebase.

## Project Overview

Bolter is a file sharing application with optional end-to-end encryption. When encryption is enabled, files are encrypted client-side using AES-GCM before upload, with encryption keys embedded in shareable URLs (never sent to server). Encryption is off by default and toggled on per-upload by the user. Supports files up to 1TB via multipart uploads to S3/Cloudflare R2.

## Commands

```bash
# Install dependencies
bun install

# Development (runs both frontend and backend via Turborepo)
bun run dev

# Run individually via turbo filtering
turbo run dev --filter=@bolter/frontend  # http://localhost:3000
turbo run dev --filter=@bolter/backend   # http://localhost:3001

# Production build (cached — second run is instant)
bun run build

# Type checking (both workspaces)
bun run typecheck

# Linting / formatting (biome, runs at root)
bun run check

# Frontend end-to-end tests (Playwright, chromium + webkit against the production build via vite preview)
cd apps/frontend && bun run e2e
cd apps/frontend && bunx playwright test --project=webkit   # WebKit only

# Docker deployment
docker compose up
```

## Turborepo

Task pipeline is defined in `turbo.json`. Key tasks:
- `build` — depends on `^build` (shared builds first), outputs cached in `dist/**`
- `dev` — persistent, not cached, depends on `^build`
- `typecheck` — depends on `^build`

Environment variables that affect build output (`VITE_*`, `SENTRY_*`, `NODE_ENV`) are in `build.env` for cache busting. Runtime-only vars (S3, Redis, limits, etc.) are in `globalPassThroughEnv`.

## Architecture

**Monorepo Structure** (Turborepo + Bun workspaces):
- `apps/frontend/` - Vite + React 18 + TypeScript + Tailwind
- `apps/backend/` - Elysia (Bun web framework) + TypeScript
- `apps/cli/` - `sendfm`, the command-line client (no CLI framework; compiled with `bun build --compile` via `scripts/build.ts`)
- `packages/shared/` - Constants exported to both (BYTES, LIMITS, DEFAULTS)
- `packages/protocol/` - `@bolter/protocol`: the wire protocol, shared by the frontend and the CLI

**Data Flow**:
1. Frontend optionally encrypts files with Web Crypto API (AES-GCM + HKDF key derivation)
2. Backend provides pre-signed S3 URLs for direct cloud uploads (no file handling)
3. Redis stores metadata (TTL, download limits, encryption flags)
4. Download URLs contain encryption key in hash fragment for client-side decryption (when encrypted)

**Resilient Uploads**:
- **Worker+OPFS upload engine (default multipart path)**: Multipart-sized uploads are delegated at the top of `uploadFiles` to a dedicated module worker under `apps/frontend/src/lib/upload-engine/`. The size gate runs twice against `UPLOAD_LIMITS.MULTIPART_THRESHOLD` (100MB) because delegation happens before zipping: first as a pre-filter on the declared input size (encrypted-adjusted), then — inside `uploadFilesViaEngine`, on the real post-zip size, before allocating — as the decision. DEFLATE routinely takes a multi-file batch under the threshold and the engine only runs multipart, so that second gate is what stops a compressible batch from allocating a multipart the backend declines on exactly this threshold (`useMultipart`, `routes/upload.ts`); the declined attempt hands its buffered zip to the legacy pipeline instead of making it compress the same files twice. An eligibility probe (worker spawn → OPFS `getDirectory` → 1-byte sync-access-handle write/read round trip) gates the delegation; any probe failure — or the kill switch `localStorage['bolter:upload-engine'] === 'off'` — falls through silently to the untouched legacy pipeline (every bullet below this block). Worker/OPFS capability cannot change mid-session, so the probe result is cached in a module-level promise and reused by every later upload — negative verdicts included, since an unhappy probe is the expensive one (a spawned-but-hung worker costs a 5s timeout). The kill switch is deliberately outside that cache: it is flipped by hand to move a stuck user off the engine, so it is re-read on every upload rather than taking effect on the next reload. `engineStartupMaintenance()` warms the cache at page load (fire-and-forget, and skipped entirely while the kill switch is on) so even the session's first upload finds the answer already decided; it warms via the internal capability probe rather than `probeEligibility`, because the latter mints the delegation-decision telemetry attempt and that must stay one per upload, not one per page load. Quota is not consulted at all (`storage.estimate()` is advisory, never vetoed the probe, and staged writes must handle a quota failure regardless). Pipeline inside the worker: slice-only producer (record-aligned chunks, `file.stream()` retired; iOS transcode growth absorbed by re-probing past declared EOF; multi-file zips run worker-side via client-zip with injected slice-backed per-file streams) → optional ECE encryption (only ciphertext ever reaches the store) → OPFS staged-part store (rolling window backpressure — the window and the uploader pool are derived from the part size by `deriveConcurrency`, and the window counts parts staged and *waiting*, because a slot frees when an uploader picks a part up rather than when its bytes are deleted, so a convoy of simultaneous part completions always finds work already staged instead of idling on staging latency; temp write → verified byte counts → `flush()`/`close()` → commit rename; the `uploads/<fileId>` directory handle is resolved once and memoized, re-resolving once if a `NotFoundError` says it went stale) → concurrent XHR uploaders (pull-based, byte-identical retries from staged parts, wall-clock stall detection — worker timers can be throttled or suspended, so correctness never depends on timer cadence; offline gating via a main-thread connectivity relay; one signed-URL refresh per part) → combined part-sequence validation (contiguous `1..k`, non-trailing parts exactly effective-size and ≥ 5 MiB) → ordered finalization (`/upload/complete` → OPFS destroy → state clear). Cancel is an acknowledged protocol: the worker aborts in-flight XHRs, performs the authenticated server-side abort, and acks `cancelled`; if no ack arrives within 10s the client terminates the worker and performs the abort itself from the main thread.
- **Engine persistence + resume decision tree**: Engine state lives in its own IndexedDB database `bolter-upload-engine` (v1; object stores `leases`/`envelopes`/`checkpoints`/`parts`) — never the legacy `bolter-uploads` DB, and vice versa; `resumeUpload` routes by which database holds the record (`hasEngineLease`). Durable records per upload: lease (uploadId/uploadToken/ownerToken, optional persisted handles), completion envelope (the exact `/upload/complete` payload, so a source-free resume can finish), producer checkpoint (next part number, source offset, ECE record counter, EOF + final-record flags), and per-part staged/uploaded/ETag records. Writes on the hot path are ordered for recovery, not for convenience: the stager commits a part record and the checkpoint that supersedes it in **one** transaction (`putPartAndCheckpoint`), and an uploader commits the uploaded+ETag record **before** the staged bytes are released. That release is then detached (fire-and-forget, errors swallowed to a debug log) so no uploader's turnaround waits on storage — a lost delete costs space only, since reconciliation reads an uploaded+ETag record as intact whether or not its file survived, and completion, cancel and startup GC all remove the directory wholesale. `planResume` (`upload-engine/resume.ts`) evaluates four branches in order — branches 1 and 2 both require the checkpoint to say production finished (EOF reached and, when encrypted, the mandatory final ECE record emitted — without it staged ciphertext is truncated and unfinishable): (1) `replay-complete` — envelope plus a full contiguous uploaded+ETag list → replay `/upload/complete` directly (idempotent via authKey; covers the lost-response window where the backend already completed and `/resume` would 404); (2) `finish-staged` — every produced part staged or uploaded → finish with no re-pick ("Finish upload — no file selection needed"; works for multi-file/zip within the crash window); (3) `need-source` — production incomplete → single-file re-pick (one-click via persisted handle when available) or multi-file start-fresh (zip production cannot restart mid-archive); (4) `unrecoverable` — no lease or envelope. `engineStartupMaintenance()` (called from `Home.tsx`) plans resume offers and garbage-collects orphaned `uploads/<fileId>` OPFS directories, holding the `upload:<fileId>` Web Lock through each delete so a live upload in another tab is never reaped.
- **Persisted-handle one-click resume (Chromium)**: `DropZone.tsx` captures `getAsFileSystemHandle()` for top-level dropped files (folder-traversal and `<input>` files stay handleless) and click-to-browse prefers `showOpenFilePicker` with `<input>` fallback. Single-file engine uploads persist the handle plus verification facts (name/size/lastModified/content fingerprint) in the lease; resume re-acquires the file via `requestPermission()` and `verifyHandleFile` rejects on any mismatch — a (name, size, mtime) tuple alone is not an identity — before feeding it back as the source.
- **Upload lifecycle extras** (`apps/frontend/src/lib/upload-lifecycle.ts`): `withUploadLifecycle` wraps both engine and legacy pipelines in a best-effort Screen Wake Lock (re-acquired on `visibilitychange`) and a once-per-session `navigator.storage.persist()` request — all feature-detected, absence is a no-op. `acquireUploadLock` holds the `upload:<fileId>` Web Lock for the full duration of a run (no probe-then-release TOCTOU); the worker holds it for the job lifetime and the OPFS GC uses it as its guard. The lock is coordination only — the durable lease is the source of truth.
- **Engine progress reporting**: The uploader coalesces byte-driven progress to a 250ms wall-clock cadence (part completions, a part's final byte and an attempt's dropped bytes always emit) and stamps each `progress` message with the worker's own `Date.now()` as `atMs`, relayed verbatim by `client.ts`. `createEngineProgressReporter` (`upload-engine/progress-reporter.ts`) folds its speed EMA once per >=1s of wall clock over that whole window's byte delta, preferring `atMs` over delivery time — timing samples by message delivery let a janky main thread divide a real byte delta by a phantom ~1ms gap and report 100+ MB/s with a seconds-away ETA. The rate origin is the *first observed* byte count (a resume's already-uploaded baseline is displayed but never folded) and the displayed count is a separate high-water mark, so a retry dropping in-flight bytes re-baselines the rate without the bar walking backwards.
- **Engine telemetry**: `trackUploadAttempt` (one per delegation decision: `engine: 'worker' | 'legacy'` plus fallback reason) and `trackEngineEvent` (`failure`/`resume`/`cancel`/`replay`/`persist-result`/`concurrency`) in `plausible.ts` correlate on a random `ua_`-prefixed 13-char per-attempt id — never a file identifier; the upload success event gains an `engine` prop. This data is the evidence for eventually deleting the legacy path. The `concurrency` event carries `peak`/`final`/`pushbacks` — `pushbacks` is the evidence for whether R2's 1 write/sec/key limit covers `UploadPart`, which the docs do not state. It rides the worker's `done` message (absent on paths that ran no uploaders, such as a completion replay).
- **Worker failures keep their own identity**: the `error` protocol message carries the worker-side error's `name` and `stack` alongside `stage`, and `EngineWorkerError` adopts that stack (exposing `stage`/`workerName`); `Home.tsx` promotes them to the Sentry tags `engine`, `engine_stage`, `engine_error`, `engine_retryable`. Structured clone does not preserve an Error's class, and every worker failure is rethrown from the same three facade frames (`worker.onmessage` → `settle` → `finish`) — since Sentry groups on the stack, without this an OPFS rename fault, a transport timeout and an HTTP 400 all file as one issue, which is exactly what BOLTER-FRONTEND-5F was.
- **OPFS commit rename is always two-argument**: `commitByRename` (`part-store.ts`) calls `move(destination, newName)`, never Chromium's one-argument `move(newName)`. `FileSystemHandle.move()` is specified by neither the WHATWG File System standard nor the WICG File System Access draft, and the engines shipped different shapes: WebKit's `FileSystemHandle.idl` declares both arguments mandatory with no overloads, so the one-argument call throws `TypeError: Not enough arguments` from the bindings' arity check — even for a same-directory rename — while Chromium accepts both forms. `typeof handle.move === 'function'` cannot see this, so the rename is additionally wrapped in a `try`/`catch` that degrades to the byte-copy path rather than failing an already-staged part. MDN BCD reports Safari 15.2 support with no note about the arity split, so browser-support tables are not a safe signal here.
- **Upload resumability**: Multipart upload state (uploadId, completed parts, encryption counter) is persisted to IndexedDB via `apps/frontend/src/lib/upload-state.ts`. On page reload, the user is prompted to resume incomplete uploads, skipping already-uploaded parts. Resumes where every part already uploaded (interrupted before `/upload/complete`) finalize directly without re-streaming, and a sub-5MiB trailing remainder uploads as a legal small trailing part (no single-part fallback during resume). When the uploader merges a small final part into the previous one, persisted resume state is invalidated — the merged part breaks the fixed-part-size offset math a resume relies on.
- **File-size-derived part sizing**: Part size is computed server-side by `calculateOptimalPartSize` (`routes/upload.ts`) as `clamp(ceilToMiB(fileSize / 1000), 64 MiB, 128 MiB)`, then corrected so the trailing part clears `MIN_PART_SIZE`. There is no client input and no preflight measurement: R2 requires every non-trailing part to be the same size (error `10048`), so part size is a one-time decision at allocation that cannot adapt mid-upload. The 64 MiB floor is set by R2's documented 1 write/sec/key limit — writes/sec against a key equal `throughput / partSize`, independent of concurrency — and the 128 MiB ceiling keeps a 1TB upload at 7,451 parts, inside `MAX_PARTS`. The trailing-part correction **loops**: a single pass can leave a sub-5MiB trailing part that R2 rejects as `EntityTooSmall` after every byte has transferred.
- **Byte-budgeted staging window**: `deriveConcurrency` (`upload-engine/engine.ts`) sizes the OPFS rolling window and the uploader pool's *cap* from a 640 MiB budget rather than a part count, so the disk footprint does not track part size (it used to: ~1.6 GB at the old 200MB default). The budget is divided by `windowSize + maxConcurrent`, **not** by the window alone — a window slot frees when an uploader *picks a part up*, but the bytes stay on disk for the whole transfer because every attempt re-reads them, so staged and in-flight parts are resident simultaneously. Dividing by the window alone understated real residency by up to 1.8x. Worst case is now 650 MiB, at the 130 MiB part size the trailing-part correction can reach, where the three-part window floor outranks the budget. 640 MiB is picked against **Safari, not Chromium**: Safari 17 (iOS 17 / macOS Sonoma) replaced the flat 1 GB per-origin quota with ~60% of disk, but iOS 16 and earlier still enforce that 1 GB, and `navigator.storage.persist()` only exempts from eviction in WebKit — it never raises the quota. `getConcurrentUploads` (`upload-shared.ts`) now serves the legacy pipeline only.
- **Adaptive uploader concurrency (AIMD)**: `createConcurrencyController` (`upload-engine/concurrency.ts`) is a pure, wall-clock-only state machine that replaces the deleted speed test as the engine's adaptive element — it observes the upload already in flight instead of spending bytes measuring the link first. The pool opens at `min(4, cap)` and ranges over `[2, cap]`: it grows by one per 10s window while saturated and with no pushback, and halves immediately on a 429 or 503, suppressing growth for 60s afterwards. Growth is driven from the uploader's progress cadence (`emitProgress` → `tick` → `reconcilePool`), never its own timer, so a stalled or offline run cannot grow itself and a throttled worker still measures one elapsed window rather than sixty. Only 429/503 shrink the pool — a 403 is pre-signed URL expiry (one refresh) and HTTP 0/network failures feed offline inference, and treating either as congestion would starve recovery. Shrinking is **cooperative at part boundaries**: a retiring worker finishes its in-flight PUT and returns rather than aborting, since aborting in-flight bytes to shrink wastes exactly what the pool exists to conserve. `runUploaders` callers that pass no controller get one pinned to `maxConcurrent`, reproducing the previous fixed pool exactly.
- **Stall detection**: Instead of hard XHR timeouts, uploads use progress-based stall detection — if no bytes are transferred for a threshold period, the part is retried. Retries pause automatically when the browser goes offline.
- **Connection quality UI**: The upload progress component displays real-time connection quality states (online/offline awareness, measured speed and ETA) and updates every second during uploads.
- **Safari/WebKit empty-chunk handling**: WebKit's ReadableStream can emit empty `Uint8Array(0)` chunks during lazy HEIC/HEVC transcoding or between internal buffer refills. The upload pipeline filters these at multiple layers — stream reading, part creation, and queue buffering — to prevent 0-byte parts that would cause R2 `InvalidPart` errors. A pre-completion consistency check hard-fails if non-trailing parts have mismatched sizes.
- **iOS transcoded file size validation**: On Safari, files picked via `<input>` may be lazily transcoded (HEIC→JPEG, HEVC→H.264), causing `File.size` to differ from actual bytes. Both the stream-based and slice-based upload paths track actual bytes sent per part (via XHR progress events) and run a pre-completion consistency check — if any non-trailing part falls below R2's 5 MiB minimum (`MIN_PART_SIZE`, 5,242,880 bytes — S3/R2 enforce MiB, not decimal MB), the upload fails early with a clear error instead of hitting a cryptic R2 `EntityTooSmall` rejection.
- **Record-aligned encrypted parts**: Encrypted multipart uploads cut parts at multiples of the 65,553-byte ECE encrypted record size (`getEffectivePartSize` in `apps/frontend/src/lib/api.ts`), so resumed uploads re-encrypt from an exact record boundary. Persisted resume state carries a schema version (`upload-state.ts`); pre-versioning encrypted resume state with completed parts is discarded as unresumable.
- **Completion is one-shot and validated**: `/upload/complete` treats a stored `auth` field as "already completed" — file IDs become public once a link is shared, so re-completion must never overwrite auth or metadata. A retry carrying the same `authKey` (uploader recovering from a lost response) returns success idempotently; anything else gets `401`. Multipart completion rejects part lists that are empty, gapped, or duplicated (parts must be contiguous `1..k`; fewer than allocated is fine) — S3 would otherwise assemble a silently corrupt object. If S3 reports `NoSuchUpload` but the object already exists (the completion committed on a lost-response retry), the route continues finalizing metadata/auth instead of stranding a dead file. Cancelled uploads abort the server-side multipart (S3 parts + Redis metadata) even when the cancel surfaces as a thrown error; terminal failures of non-resumable (multi-file) uploads do the same; and `/upload/abort` cleans up via `storage.del` so the provider file counter is decremented. `/upload/url` rolls back metadata and the provider counter if multipart creation or URL signing fails partway.

**Resilient Downloads**:
- **Range-resume with stall detection**: Downloads stream through `createResilientDownloadStream` (`apps/frontend/src/lib/api.ts`), which resumes mid-stream failures via `Range` requests (verified 206 + `Content-Range`), discards already-received bytes when a server ignores Range, refreshes expired signed URLs via `/download/url/:id`, retries with backoff (budget resets on forward progress), and aborts attempts that transfer no bytes for 60s. The legacy (pre-zipping) multi-file path consumes the same resilient stream.
- **Streaming saves**: Browser-processed downloads (encrypted, zipped-at-upload, legacy multi-file) write through the `DownloadWriter` sink in `apps/frontend/src/lib/stream-saver.ts` instead of accumulating a `Blob[]`. Three implementations are tried in order: File System Access (`showSaveFilePicker`; `prepareDiskSaveTarget` can pre-acquire the handle during the click, since the picker needs transient user activation), a StreamSaver-style service worker (`apps/frontend/public/download-stream-sw.js`, scoped to `_stream/`, credit-based backpressure over a `MessagePort`), and — last resort — in-memory buffering, hard-capped at 2 GiB with a `confirm()` above 256 MiB. The save target is opened *before* any bytes are pulled, so an oversized or declined save is refused up front instead of after the transfer; if it refuses, the in-flight response is cancelled. `downloadFile` returns an empty Blob tagged by `markSavedToDisk`, and `triggerDownload` skips those so the streamed file isn't overwritten by a 0-byte object-URL save.
- **Legacy multi-file streams too**: not-zipped-at-upload multi-file payloads (`file[0] || file[1] || …`) are split sequentially by metadata size and zipped through client-zip (`createZipStreamFromConcatenated` in `lib/zip.ts`) as bytes arrive, then piped to the same `DownloadWriter` — no ciphertext Blob, no plaintext Blob, no zip Blob. `size` is deliberately not declared to client-zip so drifted legacy metadata still yields a valid archive (actual byte counts land in each data descriptor), and trailing bytes no entry claimed are drained rather than cancelled so the `Content-Length` reconciliation still sees a complete transfer.
- **Completeness verification**: Before reporting completion, downloads verify received bytes against the advertised body length, and single-file payloads against the plaintext size from metadata. Truncated transfers fail loudly instead of saving corrupt files — the guards run before the commit and tear the writer down themselves, so no partial file survives. The advertised length comes from `advertisedBodyLength` (`apps/frontend/src/lib/api.ts`), which prefers `X-Object-Content-Length` over `Content-Length` — Bun serialises every streamed response body as `transfer-encoding: chunked` and drops an explicit `Content-Length`, so the backend fallback stream routes emit the S3 `GetObject` `ContentLength` in that custom (CORS-exposed) header instead. Without it those responses read as length 0 and the guard is skipped entirely.
- **Save before credit**: `/download/complete` is POSTed strictly after `await writer.close()` on every browser-processed path, including legacy multi-file. A failed save, a refused save target, or a service-worker commit the worker never acknowledged (`close()` fails closed on its 30s ack timeout) therefore cannot burn one of the file's limited downloads.
- **Fail-closed decryption**: `createDecryptionStream` propagates trailing-record decryption failures (no silent truncation). The encryptor always emits a final-flagged ECE record (including for exact-64KB-multiple and empty plaintexts) so truncation at record boundaries is detectable; legacy ciphertexts without a trailing final record still decrypt (warning telemetry only).
- **Reliable completion reporting**: `/download/complete` posts use the send-v1 nonce challenge-retry (`reportDownloadComplete`), so download counters increment reliably for encrypted files.
- **Download status tri-state**: `getDownloadStatus` distinguishes `ok`/`gone`/`error` so transient network failures are never rendered as "download limit reached".
- **Server-side limit gates**: `/download/url/:id`, `/download/:id`, and `/download/blob/:id` return `410` once `dl >= dlimit`; `/download/direct/:id` signs the URL before incrementing the counter so a signing failure cannot burn a download credit. `/download/complete/:id` re-reads `dlimit` from Redis after incrementing rather than judging against the pre-increment snapshot, so an owner raise landing mid-request cannot cause the file to be destroyed. `/params/:id` clamps `dlimit` to `1..MAX_DOWNLOADS` (integer) exactly as `/upload/url` does at creation — stored verbatim, a huge value makes the gate unreachable, a non-positive value bricks the file, and a float round-trips through Redis as exponential notation.
- **Limit-reached TTL cap**: when a download hits the limit, the metadata TTL is capped to a 5-minute grace window by a single atomic Redis script (`RedisStorage.capTTLAtDownloadLimit`) that re-checks `dl >= dlimit`, persists the original expiry in `expiresAt`, and applies the `EXPIRE` indivisibly. A client-side `TTL -> HSET -> EXPIRE` chain races the owner's `/params` raise in either order: the raise reads a null `expiresAt`, skips the TTL restore, and the metadata expires at ~300s while the grace timer preserves the S3 object, orphaning it behind a 404 link.
- **Auth nonce rotation**: the HMAC challenge nonce rotates only after successful authentication (failed/unauthenticated requests are challenged with the current nonce), so a viewer's in-flight requests are never invalidated by someone else's *failed* attempt. The rotation itself is a compare-and-swap on the nonce that was validated (`RedisStorage.compareAndRotateNonce`): a blind write would let two concurrent requests signing the same nonce both succeed, consuming one nonce twice. Two concurrent *successful* authentications of the same nonce therefore no longer both pass — the CAS loser gets `valid: false` plus a fresh challenge, which every authenticated client path absorbs via its one-shot 401 challenge-retry.

**Multi-Provider Storage**:
- Storage providers (S3-compatible buckets) are dynamically managed via a provider registry stored in Redis
- Each file's metadata tracks which provider it was uploaded to (`providerId` field)
- Downloads resolve the correct provider from file metadata; files without a `providerId` (pre-migration) fall back to the default (env-var) provider
- New providers can be added/activated at runtime via the `/providers` API (admin-only)
- `/upload/url` captures the active provider once per request and pins the multipart creation, all pre-signed part URLs, and stored metadata to it — a concurrent provider activation cannot split one upload across two buckets
- Provider secrets are encrypted at rest in Redis via AES-256-GCM when `PROVIDER_ENCRYPTION_KEY` is set

**Key Backend Components**:
- `apps/backend/src/routes/upload.ts` - Pre-signed URL generation, file-size-derived part sizing (`calculateOptimalPartSize`), multipart orchestration, resume endpoint
- `apps/backend/src/routes/download.ts` - URL signing, download count enforcement
- `apps/backend/src/routes/providers.ts` - Provider CRUD API (admin-only, protected by `ADMIN_API_KEY`)
- `apps/backend/src/routes/plausible.ts` - Analytics proxy (`/pl/api/event` → plausible.io). Visitor IP comes from `cf-connecting-ip` first — Cloudflare sets it to the real visitor and it survives Railway's edge/CDN rewrites of `x-forwarded-for`. Plausible silently bot-filters events whose leftmost forwarded IP is a datacenter IP (202 + `x-plausible-dropped: 1` response header), so the proxy logs dropped events and propagates the header to the browser. The proxy is not an open relay: the event's `d` (domain) must be in `PLAUSIBLE_DOMAINS` (403 otherwise), the body is capped at `MAX_EVENT_BODY_BYTES` (8 KiB → 413), the upstream fetch carries `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)` and failures return 502 instead of an unhandled 500, and `cf-connecting-ip` must parse as a real IP — plus, when `TRUSTED_EDGE_CIDRS` is set, the request peer must be inside one of those ranges or the proxy falls back to `x-forwarded-for`
- `apps/backend/src/storage/s3.ts` - S3 client with explicit config (supports multiple instances per provider)
- `apps/backend/src/storage/provider-registry.ts` - Provider registry with Redis persistence and in-memory caching
- `apps/backend/src/storage/index.ts` - Storage facade routing operations to the correct provider
- `apps/backend/src/storage/redis.ts` - Metadata operations with TTL
- `apps/backend/src/config.ts` - Environment validation

**Key Frontend Components**:
- `apps/frontend/src/lib/crypto.ts` - AES-GCM encryption, HKDF key derivation
- `apps/frontend/src/lib/plausible.ts` - Analytics entry point: `trackUpload`/`trackDownload` fan out to both Plausible (via the backend proxy) and Vercel Web Analytics (fallback provider; pageviews via `<Analytics />` in `App.tsx`). Each provider is wrapped independently so one failing never blocks the other
- `apps/frontend/src/lib/api.ts` - Direct S3 multipart uploads, download logic, stall detection, worker-engine delegation (`uploadFilesViaEngine`) and engine/legacy resume routing
- `apps/frontend/src/lib/upload-engine/` - Worker+OPFS upload engine: `client.ts` (main-thread facade — eligibility probe + kill switch, worker spawn and typed message relay, cancel escalation, startup maintenance/GC, telemetry emission), `engine.worker.ts` (worker entry wiring real deps: OPFS store, engine state DB, XHR transport, fetch API calls), `engine.ts` (transport-agnostic pipeline core `runEngine`), `producer.ts` (slice-only record-aligned producers, incl. worker-side zip), `stager.ts` (rolling-window OPFS staging with durable checkpoints), `uploader.ts` (pull-based concurrent XHR uploaders sized by the AIMD controller, wall-clock stall detection, coalesced producer-stamped progress), `concurrency.ts` (pure AIMD pool-sizing state machine + `isPushbackError`), `progress-reporter.ts` (wall-clock-windowed speed EMA / ETA / connection quality feeding the legacy `UploadProgress` shape), `completion.ts` (combined sequence validation + ordered finalization), `resume.ts` (resume decision tree, completion replay, handle verification), `part-store.ts` (`OpfsPartStore` with a memoized staging-directory handle / `MemoryPartStore`), `state.ts` (engine IndexedDB `bolter-upload-engine`), `protocol.ts` (typed client↔worker messages)
- `apps/frontend/src/lib/upload-shared.ts` - Worker-safe upload helpers shared by both pipelines (`getConcurrentUploads`, retry classification, backoff) — no DOM globals, importable from the worker
- `apps/frontend/src/lib/upload-lifecycle.ts` - Screen Wake Lock + Web Locks (`acquireUploadLock`) + once-per-session `storage.persist()` wrappers, worker-importable
- `apps/frontend/src/lib/upload-state.ts` - IndexedDB persistence for legacy multipart upload resumability (`bolter-uploads` — the engine never opens it)
- `apps/frontend/src/lib/stream-saver.ts` - `DownloadWriter` save sink: File System Access / service-worker / capped-blob strategies, strategy selection, and the blob-fallback size gate
- `apps/frontend/public/download-stream-sw.js` - Service worker backing the `service-worker` save strategy (answers a hidden-iframe navigation under `_stream/` with a `Content-Disposition: attachment` streaming response)
- `apps/frontend/src/lib/zip.ts` - Upload-time zipping plus `createZipStreamFromConcatenated`, which streams a legacy multi-file payload back into a zip without materializing it
- `apps/frontend/src/stores/app.ts` - Zustand store (config, upload state, files)
- `apps/frontend/src/pages/Home.tsx` - Upload interface
- `apps/frontend/src/pages/Download.tsx` - Download/decryption interface

**Path Alias**: `@/` maps to `apps/frontend/src/`


## `packages/protocol` — the shared wire layer

`@bolter/protocol` owns everything that *is* the Bolter protocol rather than a
way of driving it, so the web app and the CLI cannot disagree about bytes:
`crypto.ts` (ECE, HKDF, `Keychain`), `parts.ts` (`getEffectivePartSize`,
`planParts`, `plaintextRangeForPart`, `validatePartSequence`), `client.ts` (the
typed API client and the single `send-v1` challenge-retry), `metadata.ts`,
`share.ts`, `instance.ts` (discovery), `concurrency.ts` (AIMD), `retry.ts` and
`telemetry.ts`.

Three constraints hold it together:

- **No host-specific globals.** `__tests__/no-host-globals.test.ts` scans the
  whole source tree for `window`, `document`, `navigator`, `localStorage`,
  `indexedDB`, `XMLHttpRequest` and `import.meta.env`, stripping comments *and*
  string literals first so prose and error messages stay free. WebCrypto,
  `TextEncoder`, `fetch` and the stream types are fine — Bun implements them.
- **tsconfig is pinned to ES2020**, matching `apps/frontend` (the most
  conservative consumer), so an API too new for a consumer fails here rather
  than in whichever app compiles the source. `Array.prototype.at` already
  tripped this.
- **Golden vectors** (`__tests__/vectors/golden.json`) freeze the derived auth
  key, both auth headers, the deterministic metadata ciphertext, ECE output for
  five plaintext shapes, and effective part sizes. Files already stored were
  written by this implementation and their keys exist only in URLs people hold,
  so regenerating the fixture to make a test pass is the one repair that is
  never correct.

Telemetry is a registrar (`setTelemetrySink`) defaulting to silence. The browser
installs Sentry in `main.tsx`; the CLI installs its trace writer; the upload
worker installs nothing — which is why `@sentry/react` is no longer bundled into
the worker chunk to reach calls that were always inert there.

## `apps/cli` — the `sendfm` command-line client

No CLI framework (see "No CLI framework" below), compiled to standalone
binaries. What it does that the browser cannot, and why:

- **No staged copy, anywhere.** A part's bytes are a pure function of its part
  number, so the uploader asks the source for a byte range and streams it
  straight into the request. A retry asks for the same range. Encryption does
  not change this: `plaintextRangeForPart` maps an encrypted part back to the
  plaintext that produces it, exactly, because `getEffectivePartSize` floors to
  a whole number of ECE records.
- **Transport is `fetch` with a `ReadableStream` body *and* an explicit
  `Content-Length`.** Without that header Bun frames the body as
  `transfer-encoding: chunked`, which S3/R2 reject on a pre-signed PUT (signed
  `UNSIGNED-PAYLOAD`). With it, backpressure comes free from the pull contract:
  measured at ~5.5 MiB outstanding for a 128 MiB part.
- **Keep-alive is off for part PUTs.** When a server answers a streamed request
  before draining its body — exactly what S3 does for an expired pre-signed URL
  — Bun leaves the unsent body queued, and the *next* request on that
  connection returns 400. Setting `Connection: close` only on the retry does not
  help: the poison is consumed by whichever request comes next.
- **Directory uploads are resumable.** `transfer/archive.ts` computes the whole
  ZIP layout from names and sizes alone, so any byte range is derivable without
  reading content. That requires STORE (a deflated entry's size is unknown until
  it is compressed) and data descriptors (CRC-32 is a function of content, while
  the local header precedes it). Zip64 throughout. A retried range rewinds
  checksum state from a per-boundary checkpoint — without that, a re-read folds
  the same bytes into the CRC twice and the archive is corrupt while the upload
  reports success.
- **Downloads are parallel ranged GETs** into a sparse file, each decrypted from
  its own record counter (`createDecryptionStream`'s `initialCounter`). Only the
  last range expects the final-flagged record. A `200` answer to a ranged
  request is refused rather than written at that range's offset.
- **`/download/complete` is posted only after `fsync` + atomic rename**, so a
  failed save never burns one of a link's limited downloads.
- **Resume stores almost nothing**: the part plan is derived, so only the parts
  the server already has, their ETags, and the source identity are durable. A
  resume calls `/upload/multipart/:id/resume`, never `/upload/url` — allocating
  again would mint a second file id and orphan every stored part. The part plan
  is built from the *total* part count, not the resume response's `parts` array,
  which lists only what is outstanding.
- **Instance resolution has a precedence, and a link is part of it.** `-i`
  takes the address a person actually knows — a frontend origin, a bare
  hostname (upgraded to `https`, never `http`), an alias, or a whole pasted
  share link, whose `/download/<id>` path is reduced to the origin.
  `instanceRootOf` strips *only* that shape: discovery probes
  `${base}/instance.json`, so an instance mounted at a subpath works, and
  stripping every path to fix the share-link case would break it. For `get` and
  `info`, the origin in the link outranks the configured default — the default
  is where this machine *sends*, and says nothing about where someone else's
  link points — while an explicit `-i` outranks both. `Session.clientFor(origin)`
  memoises per origin because one invocation legitimately talks to two
  instances; `session.instanceExplicit` is what distinguishes "the user typed
  `-i` just now" from "an origin was resolved", which is always true.
- **Discovery tells "no API here" from "we never got there".** Deployment
  protection (Vercel, Netlify), Cloudflare Access and corporate SSO answer an
  unauthenticated probe with a 302 to *their own* login page; `fetch` follows
  it, so the probe returns 200 with HTML and is indistinguishable from an SPA
  answering every path. `discoverInstance` therefore watches for a redirect that
  lands on a *different* origin and reports `InstanceNotFoundError.interceptedBy`
  — same-origin redirects (http→https, trailing slash, canonical host) are
  ordinary and still followed. Without this a protected preview that publishes
  `/instance.json` perfectly well was told it "does not publish /instance.json yet".
- **Output contract**: stdout carries the result, stderr everything else.
  `--json` puts one versioned envelope on stdout. Exit codes and machine
  error codes both derive from one `SendfmError`, so they cannot drift.
  `data.url` is always the *complete* share link, fragment included, in `up`,
  `resume` and `ls` alike — an agent reads that field and hands it to a person,
  so a value needing assembly is a value that gets shared broken. `ls` reports
  `url: null` when an encrypted send's key was not kept; the state DB stores the
  bare url and the key in separate columns, and the fragment is joined on the
  way out.
- **No telemetry.** Redacted NDJSON traces are written locally; `sendfm report`
  bundles one on request. Redaction happens at write time, and strips signed-URL
  query strings, keys, tokens and absolute paths (splitting on both separators,
  because `node:path`'s `basename` follows the host platform and would leak a
  Windows path read on Linux).

### No CLI framework

`sendfm` has no CLI framework. `src/cli/` is ~350 lines that pick a command out
of argv, parse its flags and call its handler: `define.ts` (`defineCommand` /
`option`), `parse.ts` (`node:util`'s `parseArgs`, then each option's Zod schema),
`help.ts`, `completions.ts` and `index.ts` (`createCLI`). Runtime dependencies
are five: `@bolter/protocol`, `@bolter/shared`, `ink`, `react`, `zod`.

It used to be `@bunli/core`, and the reasons it is not are worth keeping:

- **The framework dragged a renderer behind it.** `@bunli/core` depends on
  `@bunli/runtime`, which hard-depends on `@opentui/core` and `@opentui/react`
  and imports them from its prompt runtime. `bunli build` then refused to
  cross-compile unless `@opentui/core-<platform>` resolved inside
  `apps/cli/node_modules` — a check about a renderer this CLI does not use,
  which is the entire reason the release once needed
  `bun install --os '*' --cpu '*'`. **That step is gone.** Do not reintroduce
  it; `scripts/build.ts` is `bun build --compile` per target and needs nothing
  installed for a foreign platform.
- **It broke the documented output contract.** `sendfm --help` emitted
  `{"ok":true,"data":{"type":"help",…}}` whenever stdout was not a terminal, so
  `sendfm --help | less` printed JSON — and a *different* envelope from the
  `{sendfm, ok, command, data, warnings}` one the README specifies. Help is now
  plain text on stdout when asked for, and on stderr with exit 2 when it is
  shown because the invocation was wrong.
- **Nothing was gained by it.** The generated `.bunli/commands.gen.ts` was
  referenced by no source file, and `@bunli/plugin-ai-detect`'s effects were
  never read by ours.

Migrating cost 17 import lines. `defineCommand` and `option` kept their exact
shapes and a handler still receives `{ flags, positional }`, so not one of the
13 command files changed otherwise — which is only true because the framework
was already at the edge: every handler's real work starts at `runCommand`.

Two things the parser does that are easy to undo by accident:

- **`--no-<flag>` is declared per flag, not treated as a prefix.** `parseArgs`
  has no negation and is strict, so each flag also registers a companion
  `no-<flag>` boolean. Accepting any `--no-` prefix instead would silently
  swallow `--no-instance` and every typo like it.
- **Zod does the validating.** `--limit abc` and `--limit 99999` are both
  rejected by the same schema that documents the option, so bounds cannot
  drift from their description.

Completions (`sendfm completions <bash|zsh|fish>`) are generated from the
command table, statically. A callback protocol — what the old plugin used —
makes every Tab press cost a process start and stops working entirely if the
binary moves, which is the opposite of what you want from the thing you press
when unsure. The generator escapes shell quotes, and colons in zsh descriptions
because `_describe` splits on the first one.

`scripts/build.ts` replaces `bunli build`: `--all` writes
`dist/<target>/sendfm` for the five release targets, no arguments writes a flat
`dist/sendfm` for the host. **That layout is a contract with the release
workflow's packaging loop** — flattening the multi-target case would package
one binary five times under five different names.

### The `sendfm` terminal UI

Two renderers, chosen once per transfer before the first byte, because a
renderer that redraws a line cannot be swapped in after something is printed:
an inline `\r`-redraw reporter (`ui/progress.ts`) and the Ink dashboard
(`ui/dashboard.tsx`). `shouldPromote` picks between them.

- **Ink, not OpenTUI, and not the alternate screen.** The dashboard renders
  *inline into the normal buffer*, so the last frame stays in scrollback and
  the share link printed underneath is simply the next line. The previous
  alt-screen version had to reprint its own result after teardown, because
  leaving the alternate screen discards everything drawn in it.
- **It draws on stderr.** stdout is the result — `sendfm up notes.pdf | pbcopy`
  must copy a link and nothing else. OpenTUI's `createCliRenderer` defaulted to
  `process.stdout` and was saved only by `shouldPromote` refusing to run unless
  stdout was a TTY, which is a guard rather than a design.
- **`MIN_ROWS` is derived from `DASHBOARD_ROWS`, and the test pins that.** The
  old layout stacked four separately bordered `@bunli/tui` panels — each with
  padding and a hardcoded `gap: 1` — spending ~28 rows on eight lines, while
  promotion admitted 15-row terminals. Overflow was not clipped or scrolled:
  children painted over the borders and over each other. That, not any resize
  handling, was "the TUI goes weird when you resize" — it reproduces on a plain
  100x20 terminal, first frame, with no resize at all. Any layout change must
  move `DASHBOARD_ROWS` with it.
- **Resize is a subscription, never a sample.** `useWindowSize()` re-renders on
  resize. Reading `stdout.columns` during render (what the old code did) only
  takes effect on the next progress tick, and never at all once the transfer
  has finished.
- **Colour stays monochrome.** `ui/theme.ts` is dim/bold with colour reserved
  for state that changed; `@bunli/tui`'s components painted an rgb(106,196,255)
  accent straight through it.
- **`vendor/react-devtools-core` is a deliberate 3-line stub.** Ink's reconciler
  imports the real 16 MB package behind `process.env.DEV === 'true'` — never
  true in a release — but the import is in the module graph, so
  `bun build --compile` must resolve it. `--external` is worse than useless
  here: the compiled binary then tries to resolve it at runtime from inside
  `/$bunfs` and dies on the first render. It is wired as a `file:`
  devDependency because `overrides` cannot create a node that nothing depends
  on, and `react-devtools-core` is an optional peer nobody installs. **Both
  Dockerfiles copy `apps/cli/vendor/`** — bun resolves every workspace's
  dependencies even when only the frontend is being built, so a pruned
  checkout that omits the stub fails the whole install, not just the CLI's.

`sendfm ls` prints one block per send — name, facts, link — rather than a table
followed by a block of bare URLs. The link goes to stdout when stdout is piped
and to stderr when it is a terminal, and that split is the point: interleaving
two streams per entry would leave the ordering to flush timing, which Node
guarantees to be synchronous for a terminal only on POSIX. `__tests__/ls.test.ts`
pins both halves, because on a terminal both streams land on the same screen and
nothing else would notice the contract breaking.

**`__tests__/completions.test.ts` runs the CLI from a temp directory, and must
keep doing so.** v0.1.0 shipped completions named after `process.cwd()`: the old
`completionsPlugin` resolved the command name from the filesystem at runtime
rather than from the `name` given to `createCLI`, so a shipped binary emitted a
script for `bolter-monorepo` inside this repo and plain `cli` anywhere without a
package.json — bound to a command nobody has, and shelling out to that same
missing command for candidates, so completion silently did nothing. Run from
`apps/cli` the bug is invisible, because the package.json next door happens to
say `sendfm`.

The generator that did this is gone; `src/cli/completions.ts` takes the name
from the CLI definition and reads no filesystem, so the class of bug is closed
rather than fixed. The test stays because that property is worth pinning, and
its bash assertion deliberately matches *a* registered function that the script
also defines, rather than one by name — the previous assertion pinned the old
generator's internal naming, which tested authorship rather than whether a shell
could act on the output.

### Releasing `sendfm`

Releases are cut by pushing a `v*.*.*` tag; `.github/workflows/release.yml`
does the rest. The CLI owns that tag namespace outright — the web app is
deploy-on-push and never tagged, and if it ever wants release tags it takes an
`app-v*` prefix. (The timvisee/send fork left 99 tags spanning `v0.1.0`-`v3.4.9`
in older clones. None were ever pushed here and they were deleted locally before
`v0.1.0`, so the namespace starts empty; a stale clone may still need
`git tag -d` before it can tag.)

The workflow builds the five targets, packages them, and publishes the release
itself rather than delegating to an action. `AryaLabsHQ/bunli-releaser` was the
natural fit and is what the workflow first called, but its `action.yml` has
never been valid YAML at any commit (an unquoted `Bunli CLIs: build` in the
top-level `description`), so GitHub cannot load it at any ref — and it publishes
no tags to pin. Do not reintroduce it without checking that upstream is fixed.

**The asset names are a contract with three independent consumers**, all of
which construct `sendfm-<version>-<os>-<arch>.<ext>` and expect the executable
at the *archive root*:

- `apps/frontend/public/install.sh` — served at `https://send.fm/install.sh`
- `apps/cli/src/commands/update.ts` — `assetNameFor`, backing `sendfm update`
- the Homebrew formula, once the tap ships

Renaming an asset, nesting the binary in a directory, or dropping
`checksums.txt` breaks `curl | sh` and self-update for everyone already
installed — those clients are in the wild and cannot be corrected after the
fact. `checksums.txt` is plain `sha256sum` output: `install.sh` greps for a
trailing `" <asset>"` and `update.ts` splits each line on whitespace, so the
default two-space format satisfies both. Verification is mandatory in both
consumers — a self-updater that skips it is a remote code execution primitive.

**Homebrew** ships from the `homebrew` job into `slingshot/homebrew-tap`
(`brew install slingshot/tap/sendfm`). `Formula/sendfm.rb` there is *generated*
by `apps/cli/scripts/render-formula.ts` and overwritten every release — edit the
renderer, never the tap. The renderer reads the release's own `checksums.txt`
rather than rehashing a rebuild, because Bun's compiled output is not
reproducible: a second build produces different bytes and therefore digests that
do not match the assets people download.

Four shapes in that formula are mandated by `brew style` / `brew audit --strict`
and each rejects the obvious spelling: `desc` must say "command-line", the
components run desc/homepage/license, `livecheck` takes `url :stable` plus an
explicit strategy, and there must be **no `version` stanza** — Homebrew scans the
version out of the download URL and calls an explicit one redundant. Neither
check runs in this repo's CI, so they only fail once the tap is pushed; run
`brew style slingshot/tap` and `brew audit --strict --online slingshot/tap/sendfm`
against a local edit before trusting a renderer change.

Note for docs: since Homebrew 6.0 a non-official tap needs explicit trust, and
only a **fully qualified** `brew install slingshot/tap/sendfm` grants it
implicitly — `brew tap` + bare `brew install sendfm` fails until
`brew trust --formula`. Always document the qualified form.

**npm** is a full job gated on `if: vars.PUBLISH_NPM == 'true'`. Both it and
`homebrew` gate on a *variable*, never the secret, because the `secrets` context
is **not available in a job-level `if:`** — `secrets.NPM_TOKEN != ''` would
silently read as empty and never run. Enabling npm is: add the `NPM_TOKEN`
secret, set the `PUBLISH_NPM` variable, retag. Both run after the release exists
so a failed binary build never leaves a registry advertising a version with
nothing behind it.

Both cross-repo/registry jobs need a credential this repo cannot mint:
`GITHUB_TOKEN` is scoped to `slingshot/bolter` and cannot push to the tap
whatever `permissions:` say, which is why `homebrew` takes a separate
`actions/checkout` with `HOMEBREW_TAP_TOKEN`. That token is also the quiet
failure mode of the whole pipeline — when it expires the formula simply stops
updating and nothing in this repo's CI goes red.

Reruns are safe. `workflow_dispatch` takes an existing `vX.Y.Z` tag (validated
in its own `resolve` job before it reaches `checkout`'s `ref:`), and assets
upload with `--clobber`, so re-dispatching after a build fix ships the fixed
binary rather than skipping it.

## Environment Variables

Required for local development:
- `S3_BUCKET`, `S3_ENDPOINT` - S3-compatible bucket config (used as the default provider)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` - S3 credentials for the default provider
- `REDIS_URL` - Redis connection (default: `redis://localhost:6379`)

Optional for provider management:
- `PROVIDER_ENCRYPTION_KEY` - 32-byte hex key for encrypting provider secrets in Redis
- `PROVIDER_CACHE_TTL_SECONDS` - In-memory provider cache refresh interval (default: `60`)
- `ADMIN_API_KEY` - Bearer token for provider CRUD API (`/providers/*`)

Deployment / security:
- `NODE_ENV` - Validated against `development | production | test`. Anything else, **including unset**, resolves to `production` (`config.isDevelopment` is true only for the exact string `development`). Both `apps/backend/Dockerfile` and `docker-compose.yml` set it explicitly.
- `CORS_ORIGINS` - Comma-separated extra browser origins allowed by CORS; `BASE_URL` is always allowed. Required in production whenever the frontend origin differs from the API origin.
- `PLAUSIBLE_DOMAINS` - Comma-separated site domains the analytics proxy will forward events for (default: `send.fm`)
- `TRUSTED_EDGE_CIDRS` - Comma-separated CIDRs of the edge tier allowed to set `cf-connecting-ip`. Unset keeps the legacy always-prefer-`cf-connecting-ip` behaviour.
- `HEALTH_CACHE_TTL_SECONDS` - How long a health probe result is reused (default: `30`). Set it >= your orchestrator's probe interval, or every scheduled probe misses the cache.
- `HEALTH_PROBE_TIMEOUT_MS` - Per-dependency budget for one health probe (default: `2000`).

**Request bodies are bounded twice** (`apps/backend/src/app.ts`, `routes/upload.ts`). Elysia is constructed with `serve.maxRequestBodySize = config.maxRequestBodyBytes` (4 MiB) because file bytes go straight to S3 — the API only ever receives JSON, and Bun's 128 MB default applied to every unauthenticated route. On top of that, `/upload/complete` rejects a metadata blob over `MAX_METADATA_BYTES` (512 KiB) before the file-count gate and before any S3 completion. The byte cap is the bound `MAX_FILES_PER_ARCHIVE` was only ever a proxy for: the blob is stored in Redis and re-served by `/metadata/:id` on every download-page load, the route schema is an unbounded `t.String()`, and — unlike the file count, which is unenforceable on E2E ciphertext by design — it covers encrypted shares too. `MAX_FILES_PER_ARCHIVE` is 1000; a config test pins the invariant that a full archive still fits under the byte cap.

**Startup validation is fail-fast** (`apps/backend/src/config.ts`). `buildConfig(env)` is a pure, unit-tested function: every numeric var is parsed with `Number()` and rejected if non-finite, fractional, negative or out of range (`parseInt` used to turn `MAX_FILE_SIZE='10GB'` into 10 bytes and `'abc'` into `NaN`, which removes the cap because `size > NaN` is always false); `S3_BUCKET`/`S3_ENDPOINT` must be non-empty outside `NODE_ENV=test`; defaults may not exceed their `MAX_*`. All problems are collected and printed, then `process.exit(1)`.

**CORS fails closed** (`apps/backend/src/app.ts`). `origin: true` + `credentials: true` are enabled only for `config.isDevelopment`; otherwise the allow-list is `[baseUrl, ...corsOrigins]` and `Access-Control-Allow-Credentials` is never sent.

**Health probes are bounded, not just cached** (`apps/backend/src/lib/health.ts`). `/health`, `/health/ready` and `/__heartbeat__` share one probe with three properties, because caching alone left half the failure reachable:
- **Active provider only.** The probe calls `providerRegistry.healthCheckProvider(activeId)`, never `healthCheckAll()`. Readiness never depended on the other providers — `storage.ping()` already discarded every non-active result — so an unauthenticated request could no longer fan a `HeadBucket` out across the whole registry.
- **Per-dependency timeout.** The S3 client sets no request timeout, so each dependency gets `HEALTH_PROBE_TIMEOUT_MS` (default 2s) and degrades to `false`. A decommissioned, black-holing bucket can no longer hang a probe for the socket timeout and flap readiness.
- **Stale-while-revalidate.** Results are memoised for `HEALTH_CACHE_TTL_SECONDS` (default 30s, chosen to exceed the shipped 30s compose healthcheck interval — a shorter TTL than the probe interval never hits). The caller that finds the cache stale awaits the refresh; anyone arriving while it is in flight gets the last known result rather than queueing behind it.

`resetHealthCache()` / `setHealthTiming()` / `getHealthTiming()` are the test seams. `/health/live` never touches storage. `storage.ping()` (the whole-registry fan-out) remains available for admin diagnostics but is no longer on any unauthenticated path.

See `.env.example` for full list of configurable limits and UI options.

## Operational requirements (bucket-side)

Neither of these is an environment variable and neither is detectable by `/health` (which only does a server-side `HeadBucket`), so a misconfigured bucket reports healthy and fails at runtime.

- **Bucket CORS policy.** The browser talks to the bucket directly and reads response headers that only appear when `ExposeHeaders` lists them: `ETag` (read after each multipart part, `api.ts` part completion) and `Content-Range` (read on download range-resume). Required policy: `AllowedMethods` `PUT`/`GET`/`HEAD`, `AllowedOrigins` set to the frontend origin(s), `AllowedHeaders` `*`, `ExposeHeaders` including `ETag` and `Content-Range`. Without it, multipart uploads fail *after* transferring every byte and range-resume fails with "Range resume mismatch". Full policy in `README.md` → Deployment → Operational requirements.
- **`AbortIncompleteMultipartUpload` lifecycle rule.** Interrupted multipart uploads leave LIST-invisible, billable parts that no code path aborts. A lifecycle rule (e.g. `DaysAfterInitiation: 7`) is a hard operational requirement.

## API Endpoints

- `GET /` - Interactive API documentation (Scalar UI)
- `GET /openapi.json` - Raw OpenAPI 3.x specification
- `GET /health` - Full health check (Redis + S3)
- `GET /config` - Client configuration (limits, defaults)
- `GET /instance.json` - Instance discovery document (API origin, protocol version, features, limits)
- `POST /upload/url` - Request pre-signed upload URL
- `POST /upload/complete` - Complete file upload (finalize multipart, store metadata)
- `POST /upload/abort/:id` - Abort multipart upload
- `POST /upload/multipart/:id/resume` - Resume interrupted multipart upload
- `GET /download/direct/:id` - Direct download (redirect to S3)
- `GET /download/url/:id` - Get pre-signed download URL
- `GET /download/:id` - Stream download (fallback)
- `GET /download/blob/:id` - Blob download (alternative)
- `POST /download/complete/:id` - Report download complete
- `GET /metadata/:id` - Get file metadata, plus `dl`/`dlimit`/`size`
- `GET /exists/:id` - Check file existence
- `GET /download/legacy/:id` - Check legacy system
- `POST /delete/:id` - Delete file (owner only)
- `POST /params/:id` - Update file parameters (owner only)
- `POST /info/:id` - Get file info (owner only)
- `POST /password/:id` - Set file password (owner only)
- `GET /providers` - List storage providers (admin only)
- `GET /providers/:id` - Get provider details (admin only)
- `POST /providers` - Add storage provider (admin only)
- `PUT /providers/:id` - Update storage provider (admin only)
- `DELETE /providers/:id` - Remove storage provider (admin only)
- `POST /providers/:id/ping` - Health-check a provider (admin only)
- `POST /providers/:id/activate` - Set provider as active upload target (admin only)

## Documentation Maintenance

When making changes to the project, ensure the following files stay in sync:

- **`AGENTS.md`** — architecture, commands, env vars, API endpoints, key components
- **`README.md`** — features, configuration tables, API reference, deployment instructions
- **`SECURITY.md`** — if encryption or security model changes
- **`CONTRIBUTING.md`** — if project structure or dev workflow changes

## OpenAPI Specification

Interactive API docs are served at `/` (Scalar UI) with the raw spec at `/openapi.json`, powered by `@elysiajs/openapi`.

**When adding or modifying API routes, you MUST:**
1. Add a `detail` object with `summary`, `description`, and `tags`
2. Add `response` schemas using `t.Object()` for each status code (skip for stream/redirect responses)
3. Use an existing tag: `Health`, `Configuration`, `Upload`, `Download`, `File Management`
4. Set `detail: { hide: true }` for internal endpoints not meant for public documentation
5. Keep `body`/`params`/`query` validation schemas — they auto-generate request docs
