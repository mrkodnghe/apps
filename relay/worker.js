// Route planner relay: a Cloudflare Worker that keeps the openrouteservice key secret.
// The app calls this Worker; the Worker adds the key and forwards to openrouteservice.
//
// Settings (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   ORS_KEY          Secret   your openrouteservice API key (required)
//   ALLOWED_ORIGINS  Text     comma-separated sites allowed to use the relay
//                             (default: https://mrkodnghe.github.io)
//   PER_MINUTE       Text     requests allowed per visitor per minute (default: 20)
//   ANTHROPIC_KEY    Secret   Anthropic API key, for /understand (optional; the app falls back without it)
//   AI_MODEL         Text     Claude model for /understand (default: claude-haiku-5-5)

const ORS = 'https://api.openrouteservice.org';
const PROFILES = new Set(['cycling-road', 'cycling-regular', 'cycling-mountain', 'foot-walking', 'foot-hiking']);
const MAX_ROUND_TRIP_M = 100000;   // openrouteservice free-tier limit for round trips
const CAFE_CATEGORY = 564;         // openrouteservice POI category for cafés

// ---------- AI step: turn a free-text ride request into a structured brief ----------
const BRIEF_TOOL = {
  name: 'route_brief',
  description: 'Record the structured ride brief that a route planner will use to build a loop.',
  input_schema: {
    type: 'object',
    properties: {
      activity: { type: 'string', enum: ['road', 'gravel', 'mtb'], description: 'Bike type. Default road unless gravel, off-road, trails or MTB are implied.' },
      start: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['gps', 'place'], description: 'gps when no start place is named (or "from home", "near me"); place when the rider names where to start.' },
          place: { type: 'string', description: 'Start place name as a geocodable UK place, e.g. "Guildford", "Box Hill", "Richmond Park". Only when type is place.' },
        },
        required: ['type'],
      },
      towards: { type: ['string', 'null'], description: 'A place or area the loop should head towards or pass through ("into Surrey", "out to Box Hill"), else null.' },
      distance_km: { type: 'number', description: 'Target loop distance in km. If only a time budget is given, convert it using the pace and stop rules. Clamp to 5–100.' },
      duration_min: { type: ['number', 'null'], description: 'Total time budget in minutes if the rider gave one (including "back by 12" relative to now), else null.' },
      climbing: {
        type: 'object',
        properties: {
          target_m: { type: ['number', 'null'], description: 'Total elevation gain in metres if stated or clearly implied, else null.' },
          preference: { type: 'string', enum: ['flat', 'rolling', 'hilly', 'any'] },
        },
        required: ['preference'],
      },
      quiet_roads: { type: 'boolean', description: 'True if they want quiet lanes, low traffic, or to avoid main/busy roads.' },
      cafe_stop: { type: 'boolean', description: 'True if they want a café, coffee or cake stop. False if they say no stops, or nothing about stopping on a short ride.' },
      title: { type: 'string', description: 'A short route name, 2–4 words, Title case, e.g. "Surrey Hills Loop", "Flat Coffee Spin".' },
      assumptions: { type: 'array', items: { type: 'string' }, description: 'Up to 4 short notes on guesses you made, e.g. "Loop back to start", "Road bike pace ~25 km/h".' },
    },
    required: ['activity', 'start', 'towards', 'distance_km', 'duration_min', 'climbing', 'quiet_roads', 'cafe_stop', 'title', 'assumptions'],
  },
};
const BRIEF_SYSTEM = `You turn a cyclist's free-text request into a precise brief for a UK route planner that builds loops (start and finish in the same place) on real roads.
Rules:
- Always call the route_brief tool. Never reply with plain text.
- Distances are kilometres; convert miles (1 mi = 1.609 km). Clamp distance_km to 5–100.
- Pace for converting time to distance: road 25 km/h, gravel 18 km/h, mtb 12 km/h. Subtract 20 minutes for a café stop. Hilly routes are ~15% slower.
- If neither distance nor time is given, pick a sensible distance from the wording ("quick spin" ~25 km, "long ride" ~80 km, otherwise ~45 km) and say so in assumptions.
- climbing: "flat"/"easy"/"recovery" → flat; "lumpy"/"hilly"/"climbing" → hilly; a stated figure goes in target_m (use the middle of a range).
- If a refinement is given with a previous brief, return the full updated brief: change only what the refinement asks for, keep everything else.
- Keep place names as the rider wrote them, cleaned up (capitalised, no "the" unless part of the name).`;

async function understand(env, body) {
  const text = String(body.text || '').slice(0, 600).trim();
  if (!text) return { status: 400, data: { error: 'Missing text' } };
  const ctx = body.context || {};
  const lines = [`Current local time: ${String(ctx.now || '').slice(0, 40) || 'unknown'}.`];
  if (body.previous) lines.push(`Previous brief: ${JSON.stringify(body.previous).slice(0, 2000)}`, `Refinement: ${text}`);
  else lines.push(`Request: ${text}`);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.AI_MODEL || 'claude-haiku-5-5',
      max_tokens: 600,
      system: BRIEF_SYSTEM,
      tools: [BRIEF_TOOL],
      tool_choice: { type: 'tool', name: 'route_brief' },
      messages: [{ role: 'user', content: lines.join('\n') }],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { status: 502, data: { error: 'AI request failed', detail: data && data.error && data.error.message } };
  const tool = data && Array.isArray(data.content) && data.content.find(c => c.type === 'tool_use');
  if (!tool) return { status: 502, data: { error: 'AI gave no brief' } };
  return { status: 200, data: { brief: tool.input } };
}

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
      return json({ ok: true, configured: !!env.ORS_KEY, ai: !!env.ANTHROPIC_KEY }, 200, cors);
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

      // AI: POST /understand  { text, context: { now }, previous? }  →  { brief }
      if (request.method === 'POST' && url.pathname === '/understand') {
        if (!env.ANTHROPIC_KEY) return json({ error: 'AI is not set up on the relay' }, 501, cors);
        const out = await understand(env, await request.json());
        return json(out.data, out.status, cors);
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
