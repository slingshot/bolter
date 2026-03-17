/**
 * Parse Bolter download URLs into { fileId, secretKey }
 *
 * Handles:
 *   - Full frontend URLs: https://send.fm/download/abc123#secretKey
 *   - Full API URLs:      https://api.send.fm/download/abc123#secretKey
 *   - URLs with ports:    http://localhost:3000/download/abc123#secretKey
 *   - Bare file IDs:      abc123
 */
export function parseBolterUrl(input: string): { fileId: string; secretKey: string | null } {
    const trimmed = input.trim();

    // Try parsing as a URL
    try {
        // If it looks like a URL (has ://) or starts with http
        if (trimmed.includes('://') || trimmed.startsWith('http')) {
            const url = new URL(trimmed);
            const hash = url.hash ? url.hash.slice(1) : null; // remove leading #

            // Extract file ID from pathname: /download/:id
            const pathParts = url.pathname.split('/').filter(Boolean);
            const downloadIndex = pathParts.indexOf('download');
            if (downloadIndex !== -1 && downloadIndex + 1 < pathParts.length) {
                return {
                    fileId: pathParts[downloadIndex + 1],
                    secretKey: hash || null,
                };
            }

            // If no /download/ segment, treat last path segment as file ID
            if (pathParts.length > 0) {
                return {
                    fileId: pathParts[pathParts.length - 1],
                    secretKey: hash || null,
                };
            }
        }
    } catch {
        // Not a valid URL, fall through to bare ID handling
    }

    // Handle bare ID (possibly with #key appended)
    const hashIndex = trimmed.indexOf('#');
    if (hashIndex !== -1) {
        return {
            fileId: trimmed.slice(0, hashIndex),
            secretKey: trimmed.slice(hashIndex + 1) || null,
        };
    }

    // Plain file ID
    return {
        fileId: trimmed,
        secretKey: null,
    };
}
