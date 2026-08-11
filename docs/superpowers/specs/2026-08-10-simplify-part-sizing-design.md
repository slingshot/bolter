# Delete the Preflight Speedtest; Derive Part Size Server-Side — Design Spec

**Date:** 2026-08-10
**Status:** Awaiting review
**Supersedes:** the adaptive part-sizing mechanism introduced alongside `PART_SIZE_TIERS`
**Depends on:** the worker+OPFS upload engine ([2026-08-09 spec](./2026-08-09-worker-opfs-upload-engine-design.md))

## Problem

Every multipart upload (>100MB) is preceded by a synthetic speed test. `measureUploadSpeed`
(`apps/frontend/src/lib/api.ts:146`) asks the backend to mint a throwaway multipart upload, PUTs
5×100MB of zero-filled blobs to R2 concurrently for up to 10 seconds, aborts, and asks the backend
to clean up. The resulting bytes/second goes through `getPreferredPartSize` (`api.ts:553`), which
maps it onto one of four `PART_SIZE_TIERS` — 25/50/100/200 MB — and ships it to `/upload/url` as
`preferredPartSize`.

Three things are wrong with this.

**The cost scales the wrong way.** The test runs until 500MB is sent or 10s elapse, whichever comes
first. A 2 MB/s user burns ~20MB; a 50 MB/s user burns the full 500MB. Bandwidth spent grows with
the bandwidth available, while the retry waste it protects against shrinks.

**The output is two bits.** Up to half a gigabyte and ten seconds of "Checking speed…" to choose
between four constants.

| Link | Speedtest cost | Retry waste saved by 25MB vs 200MB parts<br>(500MB upload, one disconnect per 10 min) |
|---|---|---|
| 2 MB/s | ~20 MB, 10s | ~37 MB |
| 10 MB/s | ~100 MB, 10s | ~7 MB |
| 50 MB/s | ~500 MB, 10s | ~1.5 MB |

It roughly breaks even on the slowest, flakiest links and is a pure loss everywhere else.

**It exists to compensate for a badly chosen default.** `DEFAULT_PART_SIZE` is
`200 * BYTES.MB, // increased for 1TB support` — R2 caps an upload at 10,000 parts, so 1TB needs
≥100MB parts. That worst-case constant then applies to every multipart upload, including a 120MB
one, and the speedtest is the runtime mechanism built to walk it back down. A default derived from
file size removes the need for the mechanism entirely.

## What the engine did and did not change

The worker+OPFS engine is the reason to revisit this, but it does not make the original rationale
disappear. `uploader.ts:233` re-reads the whole committed part on every attempt, so a failed 64 MiB
part still costs 64 MiB on the wire. What the engine removed is the *CPU* half of a retry (no
re-read and re-encrypt from source) and the *memory* half (parts live in OPFS, not RAM). Durable
staging plus a per-part resume decision tree also make coarse resume granularity far cheaper than it
was, which is what licenses larger parts below.

## R2 constraints (verified against Cloudflare docs, 2026-08-10)

Two findings are load-bearing for this design.

**1. Non-trailing parts must be uniform.** Documented twice — "All parts except the last must be the
same size" ([Upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/)) and
error `10048 InvalidPart`: *"All non-trailing parts must have the same size. R2 requires uniform
part sizes for multipart uploads."*
([Error codes](https://developers.cloudflare.com/r2/api/error-codes/)). S3 proper is laxer; R2 is
not. **Part size is therefore a one-time decision made at allocation, and no amount of engine
resilience can make it adaptive mid-upload.** This permanently rules out the alternative of starting
conservative and re-sizing once real throughput is known.

**2. R2 documents a per-key write rate limit.** "Maximum concurrent writes to the same object name
(key): 1 per second" ([Limits](https://developers.cloudflare.com/r2/platform/limits/)), surfacing as
`10058 TooManyRequests`.

Whether this covers `UploadPart` is **not stated**. Evidence it does not: the same docs page that
documents uniform parts advertises "Parallel upload: Yes — parts can be uploaded concurrently", and
Cloudflare's own boto3 example on that page uses `part_size = 16 * 1024 * 1024` with
`max_workers = 10` against a single key. The AWS SDK example alongside it says "Upload parts in
parallel (default: 4)". Publishing that while enforcing 1 write/sec on parts would be
self-contradictory, so the limit most likely governs mutations of the object itself (`PutObject`,
`CompleteMultipartUpload`).

**This design does not bet on that reading.** It is inference from an example, not an explicit
exemption. Part size is chosen with headroom against the limit, and adaptive concurrency (§4) exists
partly so that if the limit *does* apply, sustained 429s shrink the pool instead of failing uploads.

### Why part size, not concurrency, controls the write rate

Writes per second against the key equal `aggregate throughput ÷ partSize`. Concurrency does not
appear: N uploaders each running at 1/N of the link collectively finish the same number of parts per
second as one uploader running at full speed. So the two knobs are not interchangeable —
**concurrency fills the pipe; part size sets the request rate against the key.** At 100 MB/s: 16 MiB
parts produce 6.0 writes/sec, 64 MiB produce 1.5/sec, 128 MiB produce 0.75/sec.

## Decisions (locked 2026-08-10)

| Decision | Choice | Rejected alternative |
|---|---|---|
| Adaptive part sizing | **Delete entirely** | Cheaper ramping probe (2→8MB, 3s cap) — keeps both endpoints and the tier table to save a fraction of a cost that shouldn't exist; deriving throughput from the previous upload in the browser — new persistence surface, stale-reading risk, no help on first upload |
| Sizing input | **File size, server-side only** | Client-supplied `preferredPartSize` — splits one decision across two codebases |
| Sizing curve | `clamp(ceilToMiB(size/1000), 64 MiB, 128 MiB)` | 16 MiB floor — best resume granularity but 6 writes/sec at 100 MB/s, furthest out on the one limit we're unsure about; flat 200MB — hands every slow user the tier the speedtest existed to steer them away from |
| Staging window | **Byte-budgeted** (640 MiB) | Part-count window (`maxConcurrent + 2`) — lets the OPFS footprint track part size silently |
| Concurrency | **Adaptive in the engine**, AIMD over `[2, cap]` | Static 6 — simpler, but no self-correction if the per-key limit turns out to cover `UploadPart` |
| Legacy pipeline concurrency | **Unchanged** (`getConcurrentUploads`, 3/2) | Legacy is slated for deletion on engine telemetry; not worth touching |
| Trailing-part adjustment | **Loop it** (§2a) — fixes a live bug found while validating this curve | Ship the curve and fix separately — the new curve inherits the bug, so they cannot be decoupled |
| Out of scope | Reaper `'speedtest'` kind removal; legacy pipeline behaviour beyond deleting its preflight call | Deploy-ordering hazard (§5); legacy stays untouched by policy |

## 1. Deletions

| Location | Removed |
|---|---|
| `lib/api.ts` | `measureUploadSpeed` (`:146`, ~115 lines), `getPreferredPartSize` (`:553`), `SPEEDTEST_PART_SIZE`, `SPEEDTEST_TIMEOUT`, both preflight blocks (`:1154` legacy, `:1724` engine), `onSpeedTest` from `UploadOptions` (`:629`) and both destructurings (`:1004`, `:1669`), `preferredPartSize` from both `/upload/url` bodies |
| `pages/Home.tsx` | `onSpeedTest` callback (`:439`), `checkingSpeed` state |
| `components/UploadProgress.tsx` | `checkingSpeed` prop and the `'Checking speed...'` branch (`:33`) — status falls through to `'Preparing upload...'` then `'Uploading...'` |
| `packages/shared/config.ts` | `PART_SIZE_TIERS`, `DEFAULT_PART_SIZE` |
| `routes/upload.ts` | `POST /upload/speedtest` (`:1374`), `POST /upload/speedtest/cleanup` (`:1468`), `FixedWindowRateLimiter` (`:225`, no other caller), `speedTestRateLimiter`, `SPEEDTEST_PREFIX`, `SPEEDTEST_RATE_LIMIT`, `SPEEDTEST_RATE_WINDOW_MS`, `SPEEDTEST_REAP_AFTER_MS` |
| `AGENTS.md`, `README.md` | Preflight speed test and adaptive part sizing bullets; two API endpoint rows; configuration/feature tables |

`DEFAULT_PART_SIZE` has one non-sizing use: `routes/upload.ts:1295`, a fallback when reading
`fileInfo.partSize` back on resume. That read is replaced with `PART_SIZING.FLOOR` — `partSize` is
always written at allocation (`:542`), so the fallback is defensive only.

Net removal: two unauthenticated endpoints, an IP rate limiter that existed only to protect them,
and a 10s/≤500MB tax on every multipart upload.

## 2. Replacement sizing rule

One pure function, server-side. The client no longer has an opinion about part size.

```ts
// packages/shared/config.ts
export const PART_SIZING = {
    /** Aim for ~1000 parts; the floor and ceiling override this at both ends. */
    TARGET_PART_COUNT: 1000,
    /** Floor — keeps writes/sec against one key at ~1.5 even on a 100 MB/s link. */
    FLOOR: 64 * 1024 * 1024,
    /** Ceiling — 1 TB ÷ 128 MiB = 7,451 parts, inside R2's 10,000. */
    CEILING: 128 * 1024 * 1024,
} as const;
```

```ts
// apps/backend/src/routes/upload.ts — note: no preferredPartSize parameter
const ceilToMiB = (n: number) => Math.ceil(n / (1024 * 1024)) * (1024 * 1024);

export function calculateOptimalPartSize(fileSize: number): { partSize: number; numParts: number } {
    let partSize = Math.min(
        PART_SIZING.CEILING,
        Math.max(PART_SIZING.FLOOR, ceilToMiB(fileSize / PART_SIZING.TARGET_PART_COUNT)),
    );
    let numParts = Math.ceil(fileSize / partSize);

    // MAX_PARTS guard: unchanged.
    // Trailing-part adjustment: changed from one pass to a loop — see below.
}
```

Resulting curve (computed, including the trailing-part adjustment):

| file size | part size | parts | trailing part | adjusted? | writes/s @ 100 MB/s |
|---|---|---|---|---|---|
| 100 MB | 64 MiB | 2 | 31.4 MiB | — | 1.49 |
| 500 MB | 64 MiB | 8 | 28.8 MiB | — | 1.49 |
| 1 GB | 64 MiB | 15 | 57.7 MiB | — | 1.49 |
| 5 GB | 64 MiB | 75 | 32.4 MiB | — | 1.49 |
| 10 GB | **65 MiB** | 147 | 46.7 MiB | **yes** | 1.47 |
| 50 GB | **65 MiB** | 734 | 38.7 MiB | **yes** | 1.47 |
| 100 GB | 96 MiB | 994 | 39.4 MiB | — | 0.99 |
| 500 GB | 128 MiB | 3,726 | 37.2 MiB | — | 0.75 |
| 1 TB | 128 MiB | 7,451 | 74.3 MiB | — | 0.75 |

The `MAX_PARTS` guard is unreachable at today's 1TB `MAX_FILE_SIZE` (the ceiling caps the worst case
at 7,451 parts) but stays — it is what keeps the ceiling honest if that limit ever rises.

The trailing-part adjustment, by contrast, **fires in the middle of the range**. At 10 GB the raw
division yields 150 × 64 MiB parts with a 761 KiB trailing part — below `MIN_PART_SIZE`, which R2
rejects as `10011 EntityTooSmall`. The adjustment drops to 149 parts, recomputes, and MiB-aligns to
65 MiB / 147 parts. Two consequences the implementation must respect:

- **`CEILING` is a target, not a hard cap.** The adjustment recomputes `partSize` upward and can
  land slightly above 128 MiB (129 MiB, on 32 of the swept inputs). This is safe (three orders of
  magnitude below `MAX_PART_SIZE`) and correct — the trailing-part minimum outranks the sizing
  preference — but tests must not assert `partSize <= CEILING`. Assert `partSize <= MAX_PART_SIZE`.
- **Part size is not drawn from a fixed set.** Anything downstream assuming a part size from a small
  set of constants is wrong; `partSize` must always be read from the allocation response (as the
  engine already does via `job.partSize`).

### 2a. Pre-existing bug: the adjustment needs to loop

A property sweep of the sizing function (every 1 MB from the multipart threshold to 2 GB, then every
1 GB to 1 TB) surfaced a **latent bug in the current `calculateOptimalPartSize`, independent of this
change**: the trailing-part correction runs exactly once, and one pass is not always enough. Its
recomputed, MiB-aligned `partSize` can still leave a trailing part under `MIN_PART_SIZE`.

Sweep results against the **current shipped algorithm**:

| Part size in use | Sizes producing an illegal trailing part |
|---|---|
| 200 MB (default) | 0 |
| 100 MB tier | 0 |
| **50 MB tier** | **3** — e.g. 616 GB → 9,792 × 60 MiB, trailing 3.4 MiB |
| **25 MB tier** | **21** — e.g. 529,000,001 B → 21 × 25 MiB, trailing 4.49 MiB |

So the bug is live today, and it is reachable **only on the 25MB and 50MB tiers** — the ones handed
out to slow connections. Those uploads transfer every byte and are then rejected by R2 with
`EntityTooSmall`. It has stayed invisible because the default and the two fast tiers are clean, which
is where the overwhelming majority of uploads land.

The proposed curve would inherit it (2 failures in the same sweep, at 115 GB and 779 GB), so the fix
lands in PR 1 rather than as a follow-up: replace the single pass with a bounded loop.

```ts
let guard = 0;
while (numParts > 1 && guard++ < 64) {
    const trailing = fileSize - (numParts - 1) * partSize;
    if (trailing >= MIN_PART_SIZE) break;
    numParts -= 1;
    partSize = ceilToMiB(Math.ceil(fileSize / numParts));
    numParts = Math.ceil(fileSize / partSize);
}
```

`partSize` only ever grows across iterations, so `numParts` is monotonically non-increasing and the
loop converges — measured worst case over the full sweep is **3 iterations**. The `guard` is a
belt-and-braces bound against a future constant change introducing a cycle, not a live concern; it
must not be silently swallowed, so exhausting it should throw rather than return an illegal
allocation. With the loop in place the sweep reports zero failures across every invariant.

Interaction with encryption is unchanged: `getEffectivePartSize` (`api.ts:546`) floors the part size
to a multiple of the 65,553-byte ECE record, the backend allocates on the raw `partSize`, and the
final allocated part absorbs the residual. At a 64 MiB part that is 1023 records = 67,060,719 bytes,
comfortably above `MIN_PART_SIZE`. Completion validation already enforces "non-trailing parts exactly
effective-size", which is exactly R2's uniform-parts requirement.

## 3. Byte-budgeted staging window

`engine.ts:284` currently computes `windowSize = Math.max(1, job.maxConcurrent) + WINDOW_SLACK` — a
*part count*, so the OPFS footprint silently tracks whatever part size was chosen. Invert it: budget
the bytes, derive both knobs from the budget.

```ts
const MAX_STAGED_BYTES = 640 * 1024 * 1024; // below today's effective 5 × 200MB = 1 GB
const windowSize     = clamp(Math.floor(MAX_STAGED_BYTES / partSize), 3, 10);
const maxConcurrency = Math.max(2, windowSize - WINDOW_SLACK);
```

Derived from the *final* `partSize` — after the trailing-part adjustment, not before:

| partSize | window | concurrency cap | OPFS staged | reached by |
|---|---|---|---|---|
| 64 MiB | 10 | 8 | 640 MiB | ≤ 5 GB |
| 65 MiB | 9 | 7 | 585 MiB | 10–50 GB (adjusted) |
| 96 MiB | 6 | 4 | 576 MiB | ~100 GB |
| 128 MiB | 5 | 3 | 640 MiB | ≥ ~137 GB |

The stager needs **no change** — it still receives a fixed `windowSize` at construction. Only the
computation of that number moves. Note the `clamp(…, 3, 10)` lower bound is what guarantees
`windowSize >= maxConcurrency`, so uploaders can never starve on an over-tight window.

## 4. Adaptive concurrency

Lives in the worker, in `uploader.ts`. Not the main thread: the engine's premise is surviving a
janky or frozen main thread, and a control loop that depends on main-thread liveness would undo
that. `uploadPartsConcurrently` grows from a fixed promise array (`:370`) into a dynamic pool ranging
over `[2, maxConcurrency]`, starting at `min(4, maxConcurrency)`.

```
GROW   target += 1, probed every 10s of wall clock, when all hold:
         - no server pushback (429/503) since the last probe
         - no worker idled on the queue during the window (pool is saturated)
         - target < maxConcurrency

SHRINK target = max(2, floor(target / 2)), immediately, on any 429 or 503
         - sets a 60s cooldown before growth may resume
```

Four properties that are not negotiable:

- **Shrink is cooperative at part boundaries.** A retiring worker finishes its current part, then
  returns instead of pulling the next. Aborting in-flight bytes to shrink would waste precisely what
  this change exists to conserve.
- **Only server pushback shrinks the pool.** Offline-inferred failures keep their existing
  park-and-poll path; a 403 URL expiry keeps its one-refresh-per-part path. Neither touches
  concurrency — an outage is not congestion.
- **Wall-clock throughout**, per the existing `[R14]` rule. A probe timer throttled or suspended by
  the browser fires late; computing the delta from `opts.now()` still measures correctly, so cadence
  is never trusted.
- **No throughput gradient.** Growth is gated on saturation and absence of pushback, not on
  "throughput improved". A throughput derivative is the noisiest possible signal here (competing
  traffic, wifi variance) and buys nothing that the saturation check does not.

Honest limitation: at the 128 MiB ceiling the cap is 3, so the usable range is 2–3 and the mechanism
is really just a 429 safety valve. At the typical 64 MiB the range is 2–8 and both halves do work.

New telemetry props on the existing engine events (`trackEngineEvent` / the upload-success event):
peak concurrency, final concurrency, and 429 count. This is the evidence that settles whether R2's
per-key limit covers `UploadPart` — the same "ship it, then delete the fallback on telemetry"
posture the engine rollout used.

## 5. Compatibility and deploy ordering

Frontend (Vercel) and backend (Railway) deploy independently, so both orders must be safe.

- **New frontend + old backend** — no `preferredPartSize` is sent; the old backend falls back to its
  own `DEFAULT_PART_SIZE`. Works, with old sizing.
- **Old frontend + new backend** — `/upload/speedtest` 404s, `res.ok` is false, `measureUploadSpeed`
  returns `0` without sending a byte, `getPreferredPartSize(0)` returns `undefined`, and the new
  formula applies. Old clients get *better* behaviour: the 500MB burn disappears immediately.

Two deliberate holdbacks:

- **Keep `preferredPartSize: t.Optional(t.Number())` in the `/upload/url` schema for one release**,
  ignored, with a comment saying so. Whether Elysia strips or rejects an unknown body property is a
  configuration detail not worth betting a cached old bundle on; keeping the optional field is free
  insurance either way. Remove it in a follow-up.
- **Leave the reaper's `'speedtest'` kind alone** (`reaper.ts:27`, `:82`). Speedtest records live for
  up to 15 minutes, so some are in flight at deploy time. The implementation task must *verify* that
  a leftover record reclassified as `'file'` still reaps — `'file'` records are gated on the metadata
  key being gone, and a speedtest key never had metadata, so it should reap immediately — and only
  then schedule removal as a follow-up.

## 6. Testing

| Suite | Change |
|---|---|
| `apps/backend/src/__tests__/upload-calc.test.ts` | Rewrite for the one-argument formula. Table-driven across the nine sizes in §2, asserting `partSize`, `numParts`, `numParts <= MAX_PARTS`, `partSize <= MAX_PART_SIZE` (**not** `<= CEILING` — the trailing-part fix may exceed it), and trailing part `>= MIN_PART_SIZE`. **Must include 10 GB and 50 GB**, the sizes where the adjustment fires — a table that samples only 100MB/1GB/100GB/1TB misses it entirely and would have let this spec's original wrong numbers ship |
| `packages/shared/__tests__/config.test.ts` | Replace the `DEFAULT_PART_SIZE` invariants with `MAX_FILE_SIZE / CEILING < MAX_PARTS`, `FLOOR >= MIN_PART_SIZE`, `CEILING <= MAX_PART_SIZE`, `FLOOR <= CEILING` |
| `apps/backend/src/__tests__/upload-calc.test.ts` (property) | **The load-bearing test.** Sweep `fileSize` every 1 MB from `MULTIPART_THRESHOLD` to 2 GB, then every 1 GB to 1 TB, plus boundary values, asserting on every input: `numParts <= MAX_PARTS`, `partSize <= MAX_PART_SIZE`, `numParts * partSize >= fileSize`, and trailing part `>= MIN_PART_SIZE` when `numParts > 1`. This is the sweep that found §2a; a table of sampled sizes cannot replace it |
| `apps/backend/src/__tests__/upload-calc.test.ts` (regression) | Explicit cases for the two sizes where the single-pass adjustment failed under the new curve — 115 GB and 779 GB — plus 529,000,001 B and 616 GB, which fail today on the 25MB and 50MB tiers. Pin the iteration count at ≤ 3 so a future constant change that degrades convergence is visible |
| `apps/backend/src/__tests__/routes/upload.test.ts` | Delete speedtest route tests; assert `/upload/url` ignores a supplied `preferredPartSize` |
| `apps/backend/src/__tests__/reaper.test.ts` | Keep the `'speedtest'` cases (kind is retained); add a case for a `'speedtest'`-kind record reaping correctly with no metadata key |
| `apps/frontend/src/lib/upload-engine/__tests__/uploader.test.ts` | **New** controller cases: a transport returning 429 halves the pool; a clean transport grows to the cap; a retiring worker completes its in-flight part rather than aborting; an offline-shaped failure does *not* shrink; a late-firing probe timer still measures the correct wall-clock window |
| `apps/frontend/src/lib/upload-engine/__tests__/delegation.test.ts` | Drop speedtest expectations from the delegation path |
| `apps/frontend/e2e/helpers.ts`, `playwright.config.ts` | Remove speedtest stubs/routes |
| E2E regression | Assert no request to `/upload/speedtest` is made during a multipart upload |

The uploader's `now()`, `setTimeoutFn` and `uploadPart` are already injectable, so the controller is
testable deterministically without real timers or network.

## 7. Sequencing

Two PRs. Sections 1–3 are deletion plus one pure function and one arithmetic change; section 4 is the
only new machinery. Splitting them lets the simplification — and the removal of the 500MB tax — ship
without waiting on the controller.

1. **PR 1 — delete the speedtest, derive part size, fix the trailing-part loop, byte-budget the
   window.** Sections 1, 2, 2a, 3, 5, and the corresponding rows of 6. Concurrency stays static at
   the derived `maxConcurrency`.
2. **PR 2 — adaptive concurrency.** Section 4 and its test rows.

§2a is a bug fix that stands on its own merits and could be split out ahead of both if a faster
release is wanted — it is ~10 lines plus tests, and it fixes an `EntityTooSmall` failure that slow
connections hit today.

## Success criteria

- No multipart upload issues a request to `/upload/speedtest`; time from "Upload" to first real byte
  drops by the full preflight duration (up to 10s).
- Zero throwaway bytes uploaded per upload (down from up to 500MB).
- `/upload/speedtest` and `/upload/speedtest/cleanup` return 404; no `speedtest`-kind records are
  created.
- Part size for a given file size is reproducible from `fileSize` alone, with no client input.
- The property sweep passes on every input from `MULTIPART_THRESHOLD` to `MAX_FILE_SIZE`: no
  allocation can produce a trailing part under `MIN_PART_SIZE`, so the `EntityTooSmall` class of
  post-transfer failure is closed rather than merely made rarer.
- OPFS staged bytes per upload stay at or below 640 MiB (down from ~1 GB).
- Telemetry reports the 429 count per upload, giving a direct read on whether R2's per-key write
  limit applies to `UploadPart`.
