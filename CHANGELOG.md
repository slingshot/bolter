# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Lefthook git hooks with Biome pre-commit checks and commitlint validation
- Commitizen interactive commit helper (`bun run commit`)
- Open-source governance files (LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT)
- GitHub issue and PR templates

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
