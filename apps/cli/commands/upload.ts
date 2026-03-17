/**
 * `bolter upload <files...>` command
 *
 * Uploads one or more files to the Bolter server with optional E2E encryption.
 * Multiple files are zipped into a single archive before upload.
 * Supports resuming interrupted multipart uploads.
 */

import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { defineCommand, option } from '@bunli/core';
import qrcode from 'qrcode-terminal';
import { z } from 'zod';
import { resolveFrontend, resolveServer } from '../lib/config-store';
import { Keychain } from '../lib/crypto';
import { formatBytes, formatDuration, formatSpeed, parseDuration } from '../lib/format';
import type { UploadProgress } from '../lib/upload-engine';
import { executeResumeUpload, executeUpload } from '../lib/upload-engine';
import * as uploadState from '../lib/upload-state';
import { cleanupTempFile, zipFiles } from '../lib/zip';

// ---------------------------------------------------------------------------
// Progress bar rendering
// ---------------------------------------------------------------------------

const BAR_WIDTH = 25;

function renderProgressBar(progress: UploadProgress): string {
    const filled = Math.round((progress.percentage / 100) * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

    const loadedStr = formatBytes(progress.loaded);
    const totalStr = formatBytes(progress.total);
    const speedStr = formatSpeed(progress.speed);
    const etaStr = progress.eta > 0 ? formatDuration(progress.eta) : '--';

    return `  ${bar}  ${progress.percentage}% \u2502 ${loadedStr} / ${totalStr} \u2502 ${speedStr} \u2502 ETA ${etaStr}`;
}

function phaseLabel(phase: UploadProgress['phase']): string {
    switch (phase) {
        case 'speedtest':
            return 'Checking upload speed...';
        case 'zipping':
            return 'Compressing files...';
        case 'uploading':
            return 'Uploading';
        case 'completing':
            return 'Finalizing...';
    }
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const uploadCommand = defineCommand({
    name: 'upload',
    description: 'Upload files to Bolter',
    options: {
        encrypt: option(z.boolean().default(false), {
            short: 'e',
            description: 'Enable E2E encryption',
        }),
        expire: option(z.string().default('1d'), {
            short: 't',
            description: 'Expiry duration (e.g. 5m, 1h, 1d, 7d, 30d, 3mo, 6mo)',
        }),
        downloads: option(z.coerce.number().int().min(1).max(100).default(1), {
            short: 'd',
            description: 'Max download count (1-100)',
        }),
        server: option(z.string().optional(), {
            short: 's',
            description: 'Override server URL',
        }),
        qr: option(z.boolean().default(true), {
            description: 'Show QR code for download URL',
        }),
        resume: option(z.boolean().default(true), {
            description: 'Save state for upload resumability',
        }),
        json: option(z.boolean().default(false), {
            description: 'Output result as JSON',
        }),
    },

    async handler({ flags, positional, prompt, colors }) {
        // 1. Validate file paths
        if (positional.length === 0) {
            throw new Error('No files specified. Usage: bolter upload <files...>');
        }

        const filePaths: string[] = [];
        for (const arg of positional) {
            const resolved = resolve(arg);
            const file = Bun.file(resolved);
            if (!(await file.exists())) {
                throw new Error(`File not found: ${resolved}`);
            }
            filePaths.push(resolved);
        }

        // 2. Parse expiry duration
        const timeLimit = parseDuration(flags.expire);
        if (timeLimit === null) {
            throw new Error(
                `Invalid expiry duration: "${flags.expire}". Use formats like 5m, 1h, 1d, 7d, 30d.`,
            );
        }

        // 3. Resolve server URL
        const server = await resolveServer(flags.server);
        const frontend = await resolveFrontend();

        // 4. Determine upload file (single file or zipped archive)
        let uploadPath: string;
        let uploadName: string;
        let uploadSize: number;
        let uploadMtime: number;
        let tempZipPath: string | null = null;

        if (filePaths.length > 1) {
            // Zip multiple files
            const spinner = prompt.spinner({ text: 'Compressing files...' });
            spinner.start();

            try {
                const zip = await zipFiles(filePaths, (percent) => {
                    spinner.update(`Compressing files... ${percent}%`);
                });
                uploadPath = zip.path;
                uploadName = zip.filename;
                uploadSize = zip.size;
                tempZipPath = zip.path;

                const zipStat = await stat(zip.path);
                uploadMtime = zipStat.mtimeMs;

                spinner.succeed(
                    `Compressed ${filePaths.length} files into ${uploadName} (${formatBytes(uploadSize)})`,
                );
            } catch (err) {
                spinner.fail('Compression failed');
                throw err;
            }
        } else {
            uploadPath = filePaths[0];
            uploadName = basename(filePaths[0]);

            const fileStat = await stat(filePaths[0]);
            uploadSize = fileStat.size;
            uploadMtime = fileStat.mtimeMs;
        }

        // 5. Create keychain if encrypting
        const encrypted = flags.encrypt;
        const keychain = new Keychain();

        // 6. Check for resumable upload
        if (flags.resume) {
            const resumable = await uploadState.findResumable(uploadName, uploadSize, uploadMtime);

            if (resumable) {
                const completedParts = resumable.completedParts.length;
                const totalParts = resumable.totalParts;
                const percent = Math.round((completedParts / totalParts) * 100);

                const shouldResume = await prompt.confirm(
                    `Resume previous upload? (${completedParts}/${totalParts} parts, ${percent}% complete)`,
                    { default: true, fallbackValue: true },
                );

                if (shouldResume) {
                    const encLabel = resumable.encrypted ? ', encrypted' : '';
                    console.log(
                        `\nResuming upload of ${colors.bold(resumable.fileName)} (${formatBytes(uploadSize)}${encLabel})`,
                    );

                    const spinner = prompt.spinner({ text: 'Uploading' });
                    spinner.start();

                    const result = await executeResumeUpload(
                        uploadPath,
                        resumable,
                        server,
                        (progress) => {
                            if (progress.phase === 'uploading') {
                                spinner.update(renderProgressBar(progress));
                            } else {
                                spinner.update(phaseLabel(progress.phase));
                            }
                        },
                    );

                    spinner.succeed(
                        `Upload complete (${formatBytes(result.size)} in ${formatDuration(result.duration)})`,
                    );

                    // Reconstruct keychain for URL building
                    const resumeKeychain = resumable.encrypted
                        ? new Keychain(resumable.secretKeyB64)
                        : keychain;

                    displayResult({
                        result,
                        fileName: resumable.fileName,
                        fileSize: result.size,
                        encrypted: resumable.encrypted,
                        keychain: resumeKeychain,
                        frontend,
                        timeLimit: resumable.timeLimit,
                        downloadLimit: resumable.downloadLimit,
                        showQr: flags.qr,
                        jsonOutput: flags.json,
                        colors,
                    });

                    // Clean up temp zip if we created one
                    if (tempZipPath) {
                        await cleanupTempFile(tempZipPath);
                    }
                    return;
                }
            }
        }

        // 7. Fresh upload
        const encLabel = encrypted ? ', encrypted' : '';
        console.log(
            `\nUploading ${colors.bold(uploadName)} (${formatBytes(uploadSize)}${encLabel})`,
        );

        const spinner = prompt.spinner({ text: 'Uploading' });
        spinner.start();

        try {
            const result = await executeUpload({
                filePath: uploadPath,
                fileName: uploadName,
                fileSize: uploadSize,
                fileMtime: uploadMtime,
                encrypted,
                keychain,
                timeLimit,
                downloadLimit: flags.downloads,
                server,
                noResume: !flags.resume,
                onProgress: (progress) => {
                    if (progress.phase === 'uploading') {
                        spinner.update(renderProgressBar(progress));
                    } else {
                        spinner.update(phaseLabel(progress.phase));
                    }
                },
            });

            spinner.succeed(
                `Upload complete (${formatBytes(result.size)} in ${formatDuration(result.duration)})`,
            );

            displayResult({
                result,
                fileName: uploadName,
                fileSize: result.size,
                encrypted,
                keychain,
                frontend,
                timeLimit,
                downloadLimit: flags.downloads,
                showQr: flags.qr,
                jsonOutput: flags.json,
                colors,
            });
        } catch (err) {
            spinner.fail('Upload failed');
            throw err;
        } finally {
            // Clean up temp zip
            if (tempZipPath) {
                await cleanupTempFile(tempZipPath);
            }

            // Clean up expired resume states in the background
            uploadState.cleanupExpired().catch(() => {
                /* best-effort */
            });
        }
    },
});

// ---------------------------------------------------------------------------
// Result display
// ---------------------------------------------------------------------------

interface DisplayOptions {
    result: { id: string; ownerToken: string; duration: number; size: number };
    fileName: string;
    fileSize: number;
    encrypted: boolean;
    keychain: Keychain;
    frontend: string;
    timeLimit: number;
    downloadLimit: number;
    showQr: boolean;
    jsonOutput: boolean;
    // biome-ignore lint: colors type from bunli
    colors: any;
}

function displayResult(opts: DisplayOptions): void {
    const {
        result,
        fileName,
        fileSize,
        encrypted,
        keychain,
        frontend,
        timeLimit,
        downloadLimit,
        showQr,
        jsonOutput,
        colors,
    } = opts;

    // Build download URL
    const hash = encrypted ? `#${keychain.secretKeyB64}` : '';
    const downloadUrl = `${frontend}/download/${result.id}${hash}`;

    if (jsonOutput) {
        const output = {
            id: result.id,
            url: downloadUrl,
            ownerToken: result.ownerToken,
            fileName,
            fileSize,
            encrypted,
            expiresIn: timeLimit,
            downloadLimit,
            duration: Math.round(result.duration * 100) / 100,
        };
        console.log(JSON.stringify(output, null, 2));
        return;
    }

    // Display URL
    console.log(`\n  ${colors.cyan(downloadUrl)}\n`);

    // QR code
    if (showQr) {
        qrcode.generate(downloadUrl, { small: true }, (code) => {
            // Indent each line of the QR code
            const indented = code
                .split('\n')
                .map((line) => `  ${line}`)
                .join('\n');
            console.log(indented);
        });
        console.log();
    }

    // Summary
    const expiryStr = formatDuration(timeLimit);
    const summary = `  Expires: in ${expiryStr} \u2502 Downloads: 0/${downloadLimit}`;
    console.log(colors.dim(summary));
    console.log();
}

export default uploadCommand;
