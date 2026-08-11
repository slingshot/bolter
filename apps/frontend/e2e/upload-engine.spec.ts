/**
 * Real-browser coverage for the worker+OPFS upload engine [R17]: OPFS sync
 * access handles, module-worker chunk loading in the production build,
 * structured clone across the worker boundary, and reload recovery — none of
 * which unit-test fakes can validate. Network is mocked at the page level
 * (`e2e/helpers.ts`); no backend runs.
 */

import { expect, test } from '@playwright/test';
import {
    addGeneratedFile,
    analyticsEvents,
    installMockBackend,
    installWorkerSpy,
    listOpfsUploadDirs,
    PART_SIZE,
    readEngineCheckpoint,
    workerSpawns,
} from './helpers';

/** 150MB payload — above `MULTIPART_THRESHOLD`, so the engine gate opens. */
const PAYLOAD_BYTES = 150 * 1024 * 1024;

/** partSize 64MiB → parts of 64MiB, 64MiB and a 22MiB trailing remainder. */
const EXPECTED_PART_SIZES = [PART_SIZE, PART_SIZE, PAYLOAD_BYTES - 2 * PART_SIZE];

async function startUpload(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/');
    await addGeneratedFile(page, 'payload.bin', PAYLOAD_BYTES);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
}

test('engine path smoke: 150MB uploads through the worker with exact part sizes', async ({
    page,
}) => {
    await installWorkerSpy(page);
    const mock = await installMockBackend(page);

    await startUpload(page);
    await expect(page.getByText('Upload complete!', { exact: true })).toBeVisible({
        timeout: 150_000,
    });

    // The engine really ran in a dedicated worker built by Vite.
    const spawns = await workerSpawns(page);
    expect(spawns.filter((url) => url.includes('engine.worker'))).not.toEqual([]);

    // Every mocked part URL received exactly one PUT of the exact staged size.
    const counts = [...mock.putCounts.entries()].sort((a, b) => a[0] - b[0]);
    expect(counts).toEqual([
        [1, 1],
        [2, 1],
        [3, 1],
    ]);
    expect(mock.putSizes.get(1)).toEqual([EXPECTED_PART_SIZES[0]]);
    expect(mock.putSizes.get(2)).toEqual([EXPECTED_PART_SIZES[1]]);
    expect(mock.putSizes.get(3)).toEqual([EXPECTED_PART_SIZES[2]]);

    // Completion carries the contiguous part list with the mocked ETags.
    expect(mock.completions).toHaveLength(1);
    const completion = mock.completions[0];
    expect(completion.id).toBe(mock.fileId);
    expect(completion.actualSize).toBe(PAYLOAD_BYTES);
    expect(completion.parts?.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
    expect(completion.parts?.map((p) => p.ETag)).toEqual(['"etag-1"', '"etag-2"', '"etag-3"']);

    // The delegation decision was recorded as a worker attempt.
    const attempt = (await analyticsEvents(page)).find((e) => e.name === 'Upload Attempt');
    expect(attempt?.data?.engine).toBe('worker');
});

test('reload mid-upload: resume finishes remaining parts without re-uploading part 1', async ({
    page,
}) => {
    const mock = await installMockBackend(page, { holdParts: [2, 3] });

    await startUpload(page);

    // Part 1 completes; parts 2 and 3 are held in flight. Wait until the
    // producer checkpoint records EOF — every part is then durably staged in
    // OPFS, so the reload lands in the source-free finish-staged branch.
    await expect.poll(() => mock.putCounts.get(1), { timeout: 60_000 }).toBe(1);
    await expect
        .poll(async () => (await readEngineCheckpoint(page, mock.fileId))?.eofReached, {
            timeout: 60_000,
        })
        .toBe(true);

    await page.reload();
    await expect(page.getByText('Finish upload — no file selection needed')).toBeVisible();

    mock.releaseHeldParts();
    await page.getByRole('button', { name: 'Finish upload', exact: true }).click();
    await expect(page.getByText('Upload resumed and completed!', { exact: true })).toBeVisible({
        timeout: 150_000,
    });

    // Part 1 was never re-produced or re-uploaded; the resume re-signed URLs
    // and only pushed the two parts that had not completed.
    expect(mock.putCounts.get(1)).toBe(1);
    expect(mock.putCounts.get(2)).toBe(1);
    expect(mock.putCounts.get(3)).toBe(1);
    expect(mock.resumeCalls).toBeGreaterThanOrEqual(1);

    expect(mock.completions).toHaveLength(1);
    expect(mock.completions[0].parts?.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
});

test('kill switch: upload runs the legacy pipeline with no engine worker', async ({ page }) => {
    await installWorkerSpy(page);
    const mock = await installMockBackend(page);
    await page.addInitScript(() => localStorage.setItem('bolter:upload-engine', 'off'));

    await startUpload(page);
    await expect(page.getByText('Upload complete!', { exact: true })).toBeVisible({
        timeout: 150_000,
    });

    // No engine worker was ever spawned, and nothing was staged to OPFS.
    const spawns = await workerSpawns(page);
    expect(spawns.filter((url) => url.includes('engine.worker'))).toEqual([]);
    expect(await listOpfsUploadDirs(page)).toEqual([]);

    // The legacy pipeline still finished the upload against the same mocks.
    expect(mock.completions).toHaveLength(1);
    expect(mock.completions[0].parts?.map((p) => p.PartNumber)).toEqual([1, 2, 3]);

    // Telemetry recorded the delegation decision as legacy via kill switch.
    const attempt = (await analyticsEvents(page)).find((e) => e.name === 'Upload Attempt');
    expect(attempt?.data?.engine).toBe('legacy');
    expect(attempt?.data?.reason).toBe('kill-switch');
});

test('OPFS cleanup: no staged upload directories survive a successful upload', async ({ page }) => {
    const mock = await installMockBackend(page);

    await startUpload(page);
    await expect(page.getByText('Upload complete!', { exact: true })).toBeVisible({
        timeout: 150_000,
    });

    expect(mock.completions).toHaveLength(1);
    await expect.poll(() => listOpfsUploadDirs(page), { timeout: 30_000 }).toEqual([]);
});
