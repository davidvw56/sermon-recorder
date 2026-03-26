// Sermon Summary API — Cloudflare Worker
// Proxies Anthropic + Supadata APIs so end users don't need API keys

const ALLOWED_ORIGINS = [
  'https://davidvw56.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

const DAILY_LIMIT = 50; // max analyses per IP per day
const rateMap = new Map(); // ip -> { count, resetAt }

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin?.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function checkRate(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 86400000 });
    return true;
  }
  if (entry.count >= DAILY_LIMIT) return false;
  entry.count++;
  return true;
}

// Clean up stale rate entries periodically
function cleanRateMap() {
  const now = Date.now();
  for (const [ip, entry] of rateMap) {
    if (now > entry.resetAt) rateMap.delete(ip);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Clean rate map on each request (lightweight for small maps)
    cleanRateMap();

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const path = url.pathname;

    try {
      // POST /api/analyze — proxy to Anthropic
      if (path === '/api/analyze' && request.method === 'POST') {
        if (!checkRate(ip)) {
          return json({ error: 'Daily limit reached. Please try again tomorrow.' }, 429, cors);
        }

        const body = await request.json();
        // Only pass through safe fields
        const payload = {
          model: body.model || 'claude-sonnet-4-6',
          max_tokens: Math.min(body.max_tokens || 8000, 8000),
          messages: body.messages,
        };

        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(payload),
        });

        const data = await resp.text();
        return new Response(data, {
          status: resp.status,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /api/transcript?url=... — proxy to Supadata (initial request)
      if (path === '/api/transcript' && request.method === 'GET') {
        const ytUrl = url.searchParams.get('url');
        if (!ytUrl) return json({ error: 'Missing url parameter' }, 400, cors);

        const supUrl = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(ytUrl)}&text=true&lang=en`;
        const resp = await fetch(supUrl, {
          headers: { 'x-api-key': env.SUPADATA_KEY },
        });

        const data = await resp.text();
        return new Response(data, {
          status: resp.status,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /api/transcript/:jobId — proxy Supadata job polling
      const jobMatch = path.match(/^\/api\/transcript\/(.+)$/);
      if (jobMatch && request.method === 'GET') {
        const jobId = jobMatch[1];
        const resp = await fetch(`https://api.supadata.ai/v1/transcript/${jobId}`, {
          headers: { 'x-api-key': env.SUPADATA_KEY },
        });

        const data = await resp.text();
        return new Response(data, {
          status: resp.status,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // Health check
      if (path === '/api/health') {
        return json({ status: 'ok', rateLimit: DAILY_LIMIT }, 200, cors);
      }

      return json({ error: 'Not found' }, 404, cors);

    } catch (err) {
      return json({ error: 'Server error: ' + err.message }, 500, cors);
    }
  }
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
