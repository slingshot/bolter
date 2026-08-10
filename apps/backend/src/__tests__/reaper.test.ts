import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — must be registered BEFORE importing the reaper
// ---------------------------------------------------------------------------

const mockRedis = {
    hSet: mock(() => Promise.resolve()),
    hGet: mock(() => Promise.resolve(null as string | null)),
    hGetAll: mock(() => Promise.resolve(null as Record<string, string> | null)),
    hDel: mock(() => Promise.resolve()),
    exists: mock(() => Promise.resolve(false)),
    ttl: mock(() => Promise.resolve(-2)),
};

mock.module('../storage/redis', () => ({ redis: mockRedis, RedisStorage: class {} }));

const defaultProvider = {
    del: mock(() => Promise.resolve()),
    abortMultipartUpload: mock(() => Promise.resolve()),
};
const otherProvider = {
    del: mock(() => Promise.resolve()),
    abortMultipartUpload: mock(() => Promise.resolve()),
};

const mockRegistry = {
    getOrLoadProvider: mock((id: string) =>
        id === 'other'
            ? Promise.resolve(otherProvider)
            : Promise.reject(new Error(`Storage provider "${id}" not found`)),
    ),
    getDefaultProvider: mock(() => defaultProvider),
};

mock.module('../storage/provider-registry', () => ({
    providerRegistry: mockRegistry,
    ProviderNotFoundError: class extends Error {},
}));

const noopLogger = {
    info: () => {
        /* noop */
    },
    warn: () => {
        /* noop */
    },
    error: () => {
        /* noop */
    },
    debug: () => {
        /* noop */
    },
    child: () => noopLogger,
};
mock.module('../logger', () => ({
    logger: noopLogger,
    reaperLogger: noopLogger,
    s3Logger: noopLogger,
    uploadLogger: noopLogger,
    downloadLogger: noopLogger,
    storageLogger: noopLogger,
    providerLogger: noopLogger,
    redactPaths: [],
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import {
    getReapRecord,
    REAP_KEY,
    type ReapRecord,
    reaperIntervalSeconds,
    runReaperSweep,
    scheduleObjectReap,
    selectDueRecords,
    startReaper,
    unscheduleObjectReap,
} from '../reaper';

const NOW = 1_800_000_000_000;

function record(overrides: Partial<ReapRecord> = {}): ReapRecord {
    return {
        kind: 'file',
        id: 'file1',
        providerId: 'other',
        expiresAt: NOW - 1000,
        ...overrides,
    };
}

function scheduleHash(records: ReapRecord[]): Record<string, string> {
    return Object.fromEntries(records.map((r) => [r.id, JSON.stringify(r)]));
}

beforeEach(() => {
    for (const m of [
        mockRedis.hSet,
        mockRedis.hGet,
        mockRedis.hGetAll,
        mockRedis.hDel,
        mockRedis.exists,
        mockRedis.ttl,
        defaultProvider.del,
        defaultProvider.abortMultipartUpload,
        otherProvider.del,
        otherProvider.abortMultipartUpload,
        mockRegistry.getOrLoadProvider,
    ]) {
        m.mockClear();
    }
    mockRedis.hGetAll.mockResolvedValue(null);
    mockRedis.exists.mockResolvedValue(false);
    mockRedis.ttl.mockResolvedValue(-2);
    otherProvider.del.mockResolvedValue(undefined);
    otherProvider.abortMultipartUpload.mockResolvedValue(undefined);
    defaultProvider.del.mockResolvedValue(undefined);
});

describe('selectDueRecords', () => {
    it('should return nothing for an empty schedule', () => {
        expect(selectDueRecords(null, NOW).due).toEqual([]);
    });

    it('should return only records whose deadline has passed', () => {
        const raw = scheduleHash([
            record({ id: 'past', expiresAt: NOW - 1 }),
            record({ id: 'future', expiresAt: NOW + 60_000 }),
        ]);

        const { due } = selectDueRecords(raw, NOW);
        expect(due.map((r) => r.id)).toEqual(['past']);
    });

    it('should treat a deadline exactly at now as due', () => {
        const raw = scheduleHash([record({ id: 'exact', expiresAt: NOW })]);
        expect(selectDueRecords(raw, NOW).due.length).toBe(1);
    });

    it('should drain oldest-first and respect the per-sweep cap', () => {
        const raw = scheduleHash([
            record({ id: 'b', expiresAt: NOW - 10 }),
            record({ id: 'a', expiresAt: NOW - 100 }),
            record({ id: 'c', expiresAt: NOW - 1 }),
        ]);

        const { due } = selectDueRecords(raw, NOW, 2);
        expect(due.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('should report unparseable entries instead of throwing', () => {
        const raw = { good: JSON.stringify(record({ id: 'good' })), bad: '{not json' };
        const { due, malformed } = selectDueRecords(raw, NOW);
        expect(due.map((r) => r.id)).toEqual(['good']);
        expect(malformed).toEqual(['bad']);
    });
});

describe('scheduleObjectReap', () => {
    it('should store the record under the reap key', async () => {
        await scheduleObjectReap(record({ id: 'f1', uploadId: 'up1' }));

        const call = mockRedis.hSet.mock.calls[0] as unknown[];
        expect(call[0]).toBe(REAP_KEY);
        expect(call[1]).toBe('f1');
        expect(JSON.parse(call[2] as string).uploadId).toBe('up1');
    });

    it('should swallow Redis failures — bookkeeping must not fail an upload', async () => {
        mockRedis.hSet.mockRejectedValueOnce(new Error('redis down'));
        await expect(scheduleObjectReap(record())).resolves.toBeUndefined();
    });
});

describe('getReapRecord', () => {
    it('should return the parsed record', async () => {
        mockRedis.hGet.mockResolvedValueOnce(JSON.stringify(record({ providerId: 'other' })));
        const found = await getReapRecord('file1');
        expect(found?.providerId).toBe('other');
    });

    it('should return null for a missing or corrupt record', async () => {
        mockRedis.hGet.mockResolvedValueOnce(null);
        expect(await getReapRecord('nope')).toBeNull();
        mockRedis.hGet.mockResolvedValueOnce('{not json');
        expect(await getReapRecord('bad')).toBeNull();
    });
});

describe('unscheduleObjectReap', () => {
    it('should remove the record from the reap key', async () => {
        await unscheduleObjectReap('f1');
        expect(mockRedis.hDel.mock.calls[0]).toEqual([REAP_KEY, 'f1']);
    });
});

describe('runReaperSweep', () => {
    it('should delete the object of an expired file from its pinned provider', async () => {
        // Redis TTL expiry removes the metadata; nothing used to remove the object
        mockRedis.hGetAll.mockResolvedValue(
            scheduleHash([record({ id: 'gone', providerId: 'other' })]),
        );

        const result = await runReaperSweep(NOW);

        expect(otherProvider.del.mock.calls[0][0]).toBe('gone');
        // Never through the default provider — that would target the wrong bucket
        expect(defaultProvider.del.mock.calls.length).toBe(0);
        expect(result.reaped).toBe(1);
    });

    it('should abort an abandoned multipart upload before deleting', async () => {
        mockRedis.hGetAll.mockResolvedValue(
            scheduleHash([record({ id: 'gone', uploadId: 'mp-1' })]),
        );

        await runReaperSweep(NOW);

        expect(otherProvider.abortMultipartUpload.mock.calls[0]).toEqual(['gone', 'mp-1']);
    });

    it('should drop the schedule entry once reaped', async () => {
        mockRedis.hGetAll.mockResolvedValue(scheduleHash([record({ id: 'gone' })]));

        await runReaperSweep(NOW);

        expect(mockRedis.hDel.mock.calls).toContainEqual([REAP_KEY, 'gone']);
    });

    it('should NEVER delete an object whose metadata key still exists', async () => {
        // The owner may have extended the TTL via /params — deleting here would
        // destroy a live file
        mockRedis.hGetAll.mockResolvedValue(scheduleHash([record({ id: 'alive' })]));
        mockRedis.exists.mockResolvedValue(true);
        mockRedis.ttl.mockResolvedValue(600);

        const result = await runReaperSweep(NOW);

        expect(otherProvider.del.mock.calls.length).toBe(0);
        expect(result.reaped).toBe(0);
        expect(result.rescheduled).toBe(1);

        // Re-armed from the authoritative TTL
        const rescheduled = JSON.parse(mockRedis.hSet.mock.calls[0][2] as string);
        expect(rescheduled.expiresAt).toBe(NOW + 600_000);
    });

    it('should not touch records that are not due yet', async () => {
        mockRedis.hGetAll.mockResolvedValue(
            scheduleHash([record({ id: 'later', expiresAt: NOW + 60_000 })]),
        );

        const result = await runReaperSweep(NOW);

        expect(otherProvider.del.mock.calls.length).toBe(0);
        expect(result).toEqual({ reaped: 0, rescheduled: 0, malformed: 0, failed: 0 });
    });

    it('should sweep an abandoned speed test without an existence check', async () => {
        mockRedis.hGetAll.mockResolvedValue(
            scheduleHash([
                record({ kind: 'speedtest', id: '__speedtest__x', uploadId: 'mp-test' }),
            ]),
        );

        const result = await runReaperSweep(NOW);

        // Client-driven cleanup is optional; the server must reclaim the parts
        expect(otherProvider.abortMultipartUpload.mock.calls[0]).toEqual([
            '__speedtest__x',
            'mp-test',
        ]);
        expect(result.reaped).toBe(1);
        expect(mockRedis.exists.mock.calls.length).toBe(0);
    });

    it('should keep the record and keep going when one delete fails', async () => {
        mockRedis.hGetAll.mockResolvedValue(
            scheduleHash([
                record({ id: 'boom', expiresAt: NOW - 100 }),
                record({ id: 'ok', expiresAt: NOW - 50 }),
            ]),
        );
        otherProvider.del.mockImplementation((id: string) =>
            id === 'boom' ? Promise.reject(new Error('S3 down')) : Promise.resolve(undefined),
        );

        const result = await runReaperSweep(NOW);

        expect(result.failed).toBe(1);
        expect(result.reaped).toBe(1);
        // The failed record stays scheduled so the next sweep retries it
        expect(mockRedis.hDel.mock.calls).not.toContainEqual([REAP_KEY, 'boom']);
        expect(mockRedis.hDel.mock.calls).toContainEqual([REAP_KEY, 'ok']);
    });

    it('should fall back to the default provider for an unknown providerId', async () => {
        mockRedis.hGetAll.mockResolvedValue(
            scheduleHash([record({ id: 'orphan', providerId: 'deleted-provider' })]),
        );

        await runReaperSweep(NOW);

        expect(defaultProvider.del.mock.calls[0][0]).toBe('orphan');
    });

    it('should discard malformed schedule entries', async () => {
        mockRedis.hGetAll.mockResolvedValue({ junk: 'not json' });

        const result = await runReaperSweep(NOW);

        expect(result.malformed).toBe(1);
        expect(mockRedis.hDel.mock.calls).toContainEqual([REAP_KEY, 'junk']);
    });

    it('should return an empty result when the schedule cannot be read', async () => {
        mockRedis.hGetAll.mockRejectedValueOnce(new Error('redis down'));

        const result = await runReaperSweep(NOW);

        expect(result).toEqual({ reaped: 0, rescheduled: 0, malformed: 0, failed: 0 });
    });
});

describe('reaper scheduling configuration', () => {
    it('should default to a 5 minute interval', () => {
        delete process.env.REAPER_INTERVAL_SECONDS;
        expect(reaperIntervalSeconds()).toBe(300);
    });

    it('should honor a configured interval with a sane floor', () => {
        process.env.REAPER_INTERVAL_SECONDS = '600';
        expect(reaperIntervalSeconds()).toBe(600);
        process.env.REAPER_INTERVAL_SECONDS = '1';
        expect(reaperIntervalSeconds()).toBe(30);
        process.env.REAPER_INTERVAL_SECONDS = 'garbage';
        expect(reaperIntervalSeconds()).toBe(300);
        delete process.env.REAPER_INTERVAL_SECONDS;
    });

    it('should be startable and stoppable, and disablable by env', () => {
        const started = startReaper();
        expect(typeof started.stop).toBe('function');
        started.stop();

        process.env.REAPER_ENABLED = 'false';
        const disabled = startReaper();
        disabled.stop();
        delete process.env.REAPER_ENABLED;
    });
});
