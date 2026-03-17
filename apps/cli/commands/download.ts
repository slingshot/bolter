/**
 * bolter download <url> — download (and optionally decrypt) a file
 */

import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import type { DownloadProgress } from '../lib/download-engine';
import { downloadFile } from '../lib/download-engine';
import { formatBytes, formatDuration, formatSpeed } from '../lib/format';

// ---------------------------------------------------------------------------
// ANSI helpers (written to stderr so --json stdout stays clean)
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CHECK = `${GREEN}\u2713${RESET}`;

const BAR_WIDTH = 25;

function renderProgressBar(percentage: number): string {
    const filled = Math.round((percentage / 100) * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    return `${GREEN}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}

function writeProgress(progress: DownloadProgress): void {
    const bar = renderProgressBar(progress.percentage);
    const pct = `${progress.percentage.toFixed(0)}%`.padStart(4);
    const transferred = `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`;
    const speed = formatSpeed(progress.speed);
    const eta = progress.eta > 0 ? `ETA ${formatDuration(progress.eta)}` : '';

    const line = `  ${bar}  ${BOLD}${pct}${RESET} ${DIM}\u2502${RESET} ${YELLOW}${transferred}${RESET} ${DIM}\u2502${RESET} ${YELLOW}${speed}${RESET} ${DIM}\u2502${RESET} ${eta}`;

    process.stderr.write(`\r\x1b[K${line}`);
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const downloadCommand = defineCommand({
    name: 'download',
    description: 'Download a file from Bolter',
    options: {
        output: option(z.string().optional(), {
            short: 'o',
            description: 'Output path (file or directory, default: current directory)',
        }),
        server: option(z.string().optional(), {
            short: 's',
            description: 'Override server URL',
        }),
        json: option(z.boolean().optional().default(false), {
            description: 'Output result as JSON',
        }),
    },

    async handler({ positional, flags }) {
        const url = positional[0];
        if (!url) {
            process.stderr.write(`${BOLD}Error:${RESET} Missing required argument: <url>\n`);
            process.stderr.write(`\nUsage: bolter download <url> [options]\n`);
            process.exit(1);
        }

        const isJson = flags.json === true;

        // Build progress callback (skip when in JSON mode)
        let headerPrinted = false;
        const onProgress = isJson
            ? undefined
            : (progress: DownloadProgress) => {
                  if (!headerPrinted) {
                      // We defer the header until the first progress tick so we
                      // can show it together with the bar on the same initial render.
                      headerPrinted = true;
                  }
                  writeProgress(progress);
              };

        try {
            // Print download header before starting (non-JSON mode)
            if (!isJson) {
                // We don't know file details yet — they appear once metadata is fetched
                // inside downloadFile.  The progress bar line will replace this.
                process.stderr.write(`${DIM}Resolving file...${RESET}\n`);
            }

            const result = await downloadFile({
                url,
                outputPath: flags.output,
                serverOverride: flags.server,
                onProgress,
                json: isJson,
            });

            if (isJson) {
                // Clean JSON to stdout
                const output = {
                    filePath: result.filePath,
                    fileName: result.fileName,
                    fileSize: result.fileSize,
                    encrypted: result.encrypted,
                    duration: result.duration,
                };
                process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
            } else {
                // Clear the progress line and print summary
                process.stderr.write('\r\x1b[K');

                const encLabel = result.encrypted ? ', encrypted' : '';
                const sizeStr = formatBytes(result.fileSize);
                const durStr = formatDuration(result.duration);

                process.stderr.write(
                    `${CHECK} Saved to ${BOLD}${result.filePath}${RESET} (${sizeStr}${encLabel} in ${durStr})\n`,
                );
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            if (isJson) {
                process.stdout.write(`${JSON.stringify({ error: message })}\n`);
            } else {
                // Clear any in-progress bar
                process.stderr.write('\r\x1b[K');
                process.stderr.write(`${BOLD}\x1b[31mError:${RESET} ${message}\n`);
            }

            process.exit(1);
        }
    },
});
