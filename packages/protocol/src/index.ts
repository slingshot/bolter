/**
 * `@bolter/protocol` — the Bolter wire protocol, independent of how it is driven.
 *
 * Everything here runs unchanged in a browser tab, a dedicated Web Worker and a
 * compiled Bun binary. Transport, storage and telemetry are supplied by the
 * consumer; this package owns the parts that must be byte-identical across all
 * of them, because a client that disagrees about part boundaries or record
 * counters produces files no other client can read.
 */

export * from './client';
export * from './concurrency';
export * from './crypto';
export * from './instance';
export * from './metadata';
export * from './parts';
export * from './retry';
export * from './share';
export * from './telemetry';
