/**
 * Terminal palette, matching the product.
 *
 * send.fm is strictly monochrome — black ground, near-white text, grey rules,
 * and no brand accent anywhere (see apps/frontend/tailwind.config.js). The
 * terminal follows: everything is default, dim or bold at rest, and colour is
 * reserved for state that has actually changed. A CLI that colours its chrome
 * has nothing left to say when something goes wrong.
 */

/** Written as an escape rather than a literal ESC byte: an invisible control
 * character in source is impossible to review and easy to lose to a copy-paste. */
const CSI = '\u001B[';

type Style = (text: string) => string;

const wrap =
    (open: string, close = '0'): Style =>
    (text) =>
        `${CSI}${open}m${text}${CSI}${close}m`;

const identity: Style = (text) => text;

export interface Theme {
    /** Primary text — the thing being said. */
    primary: Style;
    /** Supporting detail: sizes, counts, timings. */
    secondary: Style;
    /** Chrome: rules, labels, units. */
    muted: Style;
    /** Emphasis without colour. */
    bold: Style;
    success: Style;
    warning: Style;
    danger: Style;
    /** A share link, which people select and copy. */
    link: Style;
    enabled: boolean;
}

const plain: Theme = {
    primary: identity,
    secondary: identity,
    muted: identity,
    bold: identity,
    success: identity,
    warning: identity,
    danger: identity,
    link: identity,
    enabled: false,
};

const coloured: Theme = {
    primary: identity,
    secondary: wrap('2'),
    muted: wrap('2'),
    bold: wrap('1', '22'),
    success: wrap('32'),
    warning: wrap('33'),
    danger: wrap('31'),
    link: wrap('4', '24'),
    enabled: true,
};

/**
 * NO_COLOR is honoured unconditionally (no-color.org), and a non-TTY gets no
 * escapes at all so redirected output stays parseable.
 */
export function resolveTheme(opts: {
    isTTY: boolean;
    noColor: boolean;
    env: Record<string, string | undefined>;
}): Theme {
    if (opts.noColor || opts.env.NO_COLOR !== undefined || opts.env.TERM === 'dumb') {
        return plain;
    }
    if (opts.env.FORCE_COLOR !== undefined && opts.env.FORCE_COLOR !== '0') {
        return coloured;
    }
    return opts.isTTY ? coloured : plain;
}

export const symbols = {
    ok: '✓',
    warn: '⚠',
    fail: '✗',
    bullet: '·',
    arrow: '→',
} as const;
