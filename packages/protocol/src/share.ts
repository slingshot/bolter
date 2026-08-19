/**
 * Share URLs.
 *
 * The decryption key lives in the fragment because fragments are never sent
 * to a server — not in the request line, not in `Referer`. Everything here
 * exists to keep it that way, including on the parsing side: a CLI handed a
 * share link must split it locally rather than fetching it.
 */

export interface ShareUrlParts {
    /** Origin the link points at — the web app, not necessarily the API. */
    origin: string;
    id: string;
    /** base64url secret from the fragment; empty for an unencrypted share. */
    secret: string;
}

export function buildShareUrl(opts: {
    /** Download URL without a fragment, as `/upload/complete` returns it. */
    url: string;
    secret?: string;
    encrypted: boolean;
}): string {
    if (!opts.encrypted || !opts.secret) {
        return opts.url;
    }
    return `${opts.url}#${opts.secret}`;
}

/**
 * Parse `https://send.fm/download/<id>#<secret>`.
 *
 * Throws rather than guessing: a mistyped link that silently parsed to the
 * wrong id would produce a confusing 404 instead of a clear message.
 */
export function parseShareUrl(input: string): ShareUrlParts {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new Error(`not a valid URL: ${input}`);
    }
    const match = url.pathname.match(/\/download\/([^/]+)\/?$/);
    if (!match) {
        throw new Error(
            `not a Bolter share link: expected a /download/<id> path, got "${url.pathname}"`,
        );
    }
    return {
        origin: url.origin,
        id: match[1],
        secret: url.hash.startsWith('#') ? url.hash.slice(1) : '',
    };
}
