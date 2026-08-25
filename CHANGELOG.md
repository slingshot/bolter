# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`sendfm`, a command-line client** (`apps/cli`). Sends and receives against
  any Bolter-compatible instance, with `--json` on every command. Because it
  runs on a filesystem it needs no staged copy: a part's bytes are a pure
  function of its part number, so retries and resumes re-read the source,
  directory uploads are resumable (the browser's are not), and downloads fetch
  many ranges in parallel rather than one sequential stream. Distributed as
  standalone binaries via GitHub Releases and Homebrew, and on npm as a
  launcher plus per-platform packages so no Bun is required
- **`@bolter/protocol`** (`packages/protocol`), the wire protocol shared by the
  web app and the CLI: ECE crypto, part planning, the typed API client, the
  `send-v1` challenge-retry, metadata encoding, share URLs and instance
  discovery. Golden vectors freeze the bytes so neither client can drift
- **`GET /instance.json`**, served by both the backend and the frontend build,
  so a client holding only a share link can find the API, learn the instance's
  limits and negotiate protocol compatibility
- `dl`, `dlimit` and `size` on `GET /metadata/:id`, so "how many downloads are
  left" no longer requires minting and discarding a pre-signed URL
- A MinIO service under a `test` compose profile, so multipart assembly, ETags,
  Range requests and `EntityTooSmall`/`InvalidPart` can be exercised against
  real S3 semantics rather than a mock
- Adaptive uploader concurrency in the worker upload engine (AIMD): the pool grows while
  saturated and halves on HTTP 429/503, replacing the deleted speed test as the engine's
  adaptive element. Shrinking is cooperative at part boundaries, so no in-flight bytes are
  discarded
- `concurrency` engine telemetry event carrying peak/final pool size and pushback count
- Lefthook git hooks with Biome pre-commit checks and commitlint validation
- Commitizen interactive commit helper (`bun run commit`)
- Open-source governance files (LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT)
- GitHub issue and PR templates

### Fixed

- Two `upload-state` tests depended on nothing listening on port 3001: they
  reach the network through `cleanupExpiredUploads`, which aborts an abandoned
  multipart before forgetting its uploadId. With a backend dev server running
  they hung until the test timed out; CI never saw it because there the
  connection is refused immediately
- `@sentry/react` was bundled into the upload worker to reach `captureError`
  calls that were inert there (the worker has no Sentry client)
- The backend's isolated test suite ran its whole directory in one process, so
  `mock.module` — which is process-global — leaked between files


### Changed

- **Multipart part size is now derived from file size on the server**
  (`clamp(ceilToMiB(fileSize / 1000), 64 MiB, 128 MiB)`) instead of being chosen by the client
  from a measured bandwidth tier. R2 requires every non-trailing part to be the same size, so
  the choice can never adapt mid-upload — measuring first bought nothing
- OPFS staging is bounded by a 640 MiB *residency* budget (staged **plus** in-flight parts),
  down from ~1.6 GB, sized to stay inside the 1 GB per-origin quota that iOS 16 and earlier
  still enforce
- `POST /upload/url` accepts but ignores `preferredPartSize`; the field will be removed a
  release from now

### Removed

- **`POST /upload/speedtest` and `POST /upload/speedtest/cleanup`.** Every multipart upload ran
  a preflight probe that pushed up to 500 MB of throwaway data for up to 10 seconds to pick
  between four part-size constants. Uploads now start on their first real byte
- The "Checking speed…" upload status, along with the IP rate limiter that existed only to
  protect the speed-test endpoints

### Fixed

- **Multipart allocations could produce a trailing part below R2's 5 MiB minimum**, failing the
  upload with `EntityTooSmall` *after* every byte had transferred. The correction pass ran only
  once and one pass is not always enough; it now loops. Reachable on the 25 MB and 50 MB part
  sizes, which were handed to slow connections
- `bun run check` no longer walks build output — running it after `bun run build` previously
  hung indefinitely on minified bundles
