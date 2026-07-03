import { Elysia } from 'elysia';
import { plausibleLogger as logger } from '../logger';

const PLAUSIBLE_API = 'https://plausible.io';

export const plausibleRoutes = new Elysia({ prefix: '/pl' }).post(
    '/api/event',
    async ({ request }) => {
        // Plausible attributes the visitor to the leftmost X-Forwarded-For entry
        // and silently bot-filters the event (202 + x-plausible-dropped) when
        // that entry is a datacenter IP. Behind Cloudflare → Railway, the
        // x-forwarded-for chain is rewritten by Railway's edge/CDN and its
        // leftmost entry is not guaranteed to be the visitor; cf-connecting-ip
        // is set by Cloudflare to the real visitor IP and passes through
        // untouched, so it must win when present.
        const clientIp =
            request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';

        const response = await fetch(`${PLAUSIBLE_API}/api/event`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': request.headers.get('user-agent') || '',
                'X-Forwarded-For': clientIp,
            },
            body: request.body,
        });

        // Plausible returns 202 even for events it discards; the only signal is
        // this header. Log it and pass it through so drops are observable both
        // server-side and from browser devtools.
        const dropped = response.headers.get('x-plausible-dropped');
        if (dropped) {
            logger.warn({ clientIp }, 'Plausible dropped event (bot-filtered upstream)');
        }

        return new Response(response.body, {
            status: response.status,
            headers: dropped ? { 'x-plausible-dropped': dropped } : undefined,
        });
    },
    {
        detail: { hide: true },
    },
);
