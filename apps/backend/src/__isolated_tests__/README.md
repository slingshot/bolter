# Isolated tests

Tests in this directory run in their own `bun test` process (see the `test`
script in `apps/backend/package.json`), separately from `src/__tests__`.

## Why

Bun's `mock.module` is **process-global and is never reset between test files**,
and `mock.restore()` does not undo it. Whichever file bun loads first wins, and
load order is `readdir` order — which differs between macOS (local) and Linux
(CI). That makes any test which imports a module a sibling stubs order-dependent:
green locally, red in CI, or vice versa.

Most cases are fixable in place by importing through a query-suffixed specifier,
which is a different key from the one the mock is registered against:

```ts
const REAL = '../storage/redis.ts?unmocked' as string;
const { RedisStorage } = (await import(REAL)) as typeof import('../storage/redis');
```

(The `as string` keeps the specifier non-literal so `tsc` doesn't try to resolve
the query form; the cast restores typing.) That is what
`storage-guards.test.ts`, `redis-cap-ttl.test.ts`, `redis-nonce-cas.test.ts` and
`logger.test.ts` do.

That trick is not sufficient when a test needs the **real module graph to be
internally consistent** — the real `storage/index.ts` facade wired to the real
`providerRegistry` singleton wired to this file's fake `S3Storage`. Resolving one
module past the mock registry creates a *fresh instance* whose own imports bind
to whatever stubs happened to be registered at that moment, so the facade and the
test end up holding different singletons. `provider-storage.test.ts` is exactly
that case: it deliberately exercises the production wiring
(`storage.setField` → `providerRegistry.trackFile` → `getFileCount` →
`removeProvider`) rather than a re-implementation, and five sibling files
(`deployment`, `health`, `reaper`, `routes/upload`, `routes/providers`) globally
stub `../storage/provider-registry`.

A separate process gives it a clean module registry, so it can keep using plain
imports and keep asserting against the real wiring.

## When to add a file here

Only when a test needs a consistent real module graph that siblings globally
stub. Prefer the query-suffixed specifier first — it keeps everything in one
process and one test run.
