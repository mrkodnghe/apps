// Route planner relay: a Cloudflare Worker that keeps the openrouteservice key secret.
// The app calls this Worker; the Worker adds the key and forwards to openrouteservice.
//
// Settings (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   ORS_KEY          Secret   your openrouteservice API key (required)
//   ALLOWED_ORIGINS  Text     comma-separated sites allowed to use the relay
//                             (default: https://mrkodnghe.github.io)
//   PER_MINUTE       Text     requests allowed per visitor per minute (default: 20)

const ORS = 'https://api.openrouteservice.org';
const PROFILES = new Set(['cycling-road', 'cycling-regular', 'cycling-mountain', 'foot-walking', 'foot-hiking']);
const MAX_ROUND_TRIP_M = 100000;   // openrouteservice free-tier limit for round trips
const CAFE_CATEGORY = 564;         // openrouteservice POI category for cafés

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://mrkodnghe.github.io').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, configured: !!env.ORS_KEY }, 200, cors);
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (!originOk) return json({ error: 'This site is not allowed to use the relay' }, 403, cors);
    if (!env.ORS_KEY) return json({ error: 'Relay is missing its ORS_KEY secret' }, 500, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!allow(ip, Number(env.PER_MINUTE) || 20)) return json({ error: 'Too many requests, please slow down' }, 429, cors);

    try {
      // Routes: POST /directions/{profile}  (body = openrouteservice directions request)
      if (request.method === 'POST' && url.pathname.startsWith('/directions/')) {
        const profile = url.pathname.split('/')[2];
        if (!PROFILES.has(profile)) return json({ error: 'Unknown profile' }, 400, cors);
        const body = await request.json();
        if (!Array.isArray(body.coordinates) || body.coordinates.length < 1 || body.coordinates.length > 5) return json({ error: 'Bad coordinates' }, 400, cors);
        const rt = body.options && body.options.round_trip;
        if (rt && Number(rt.length) > MAX_ROUND_TRIP_M) return json({ error: 'Round trip too long' }, 400, cors);
        const res = await fetch(`${ORS}/v2/directions/${profile}/geojson`, {
          method: 'POST',
          headers: { 'Authorization': env.ORS_KEY, 'Content-Type': 'application/json', 'Accept': 'application/geo+json' },
          body: JSON.stringify(body),
        });
        return pass(res, cors);
      }

      // Place search: GET /geocode?text=Guildford  (cached for a day to save quota)
      if (request.method === 'GET' && url.pathname === '/geocode') {
        const text = (url.searchParams.get('text') || '').trim().slice(0, 100);
        if (!text) return json({ error: 'Missing text' }, 400, cors);
        const cache = caches.default;
        const cacheKey = new Request(`https://relay-cache.local/geocode?text=${encodeURIComponent(text.toLowerCase())}`);
        let res = await cache.match(cacheKey);
        if (!res) {
          const up = await fetch(`${ORS}/geocode/search?api_key=${encodeURIComponent(env.ORS_KEY)}&text=${encodeURIComponent(text)}&boundary.country=GB&size=1`);
          res = new Response(up.body, up);
          res.headers.set('Cache-Control', 'public, max-age=86400');
          if (up.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
        }
        return pass(res, cors);
      }

      // Cafés near a point: POST /pois  { geometry: { geojson: {type:'Point', coordinates:[lon,lat]}, buffer }, limit }
      if (request.method === 'POST' && url.pathname === '/pois') {
        const b = await request.json();
        const g = b && b.geometry;
        const c = g && g.geojson && g.geojson.type === 'Point' && g.geojson.coordinates;
        if (!Array.isArray(c) || c.length < 2) return json({ error: 'Bad geometry' }, 400, cors);
        const body = {
          request: 'pois',
          geometry: { geojson: { type: 'Point', coordinates: [Number(c[0]), Number(c[1])] }, buffer: Math.min(Number(g.buffer) || 2000, 2000) },
          filters: { category_ids: [CAFE_CATEGORY] },
          limit: Math.min(Number(b.limit) || 20, 20),
        };
        const res = await fetch(`${ORS}/pois`, {
          method: 'POST',
          headers: { 'Authorization': env.ORS_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return pass(res, cors);
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'Relay error' }, 502, cors);
    }
  },
};

function pass(res, cors) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  h.delete('set-cookie');
  h.delete('content-length');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Best-effort per-visitor limit (per Worker instance). Stops casual abuse of the daily allowance.
const hits = new Map();
function allow(ip, perMinute) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= perMinute) { hits.set(ip, recent); return false; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return true;
}
