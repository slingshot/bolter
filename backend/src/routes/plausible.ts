import { Elysia } from 'elysia';

const PLAUSIBLE_API = 'https://plausible.io';

export const plausibleRoutes = new Elysia({ prefix: '/pl' })
  .post('/api/event', async ({ request }) => {
    const clientIp = request.headers.get('x-forwarded-for') ||
                     request.headers.get('cf-connecting-ip') ||
                     '';

    const response = await fetch(`${PLAUSIBLE_API}/api/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': request.headers.get('user-agent') || '',
        'X-Forwarded-For': clientIp,
      },
      body: request.body,
    });

    return new Response(response.body, { status: response.status });
  });
