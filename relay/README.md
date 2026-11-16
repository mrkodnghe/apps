# Route planner relay (Cloudflare Worker)

Keeps the openrouteservice API key out of the public web page. The app calls this Worker, and the Worker adds the key and forwards the request to openrouteservice.

It only accepts requests from the sites listed in `ALLOWED_ORIGINS`, only allows the cycling and walking route types, caps round trips at 100 km, only looks up cafés, caches place searches for a day, and limits each visitor to `PER_MINUTE` requests a minute.

## Set up (Cloudflare dashboard, about 5 minutes)

1. **Workers & Pages → Create → Create Worker.** Name it `route-relay` and click **Deploy**.
2. Click **Edit code**, replace everything with the contents of [`worker.js`](worker.js), then click **Deploy**.
3. Go to the Worker's **Settings → Variables and Secrets** and add:
   - `ORS_KEY`, type **Secret**, value: your openrouteservice API key
   - `ALLOWED_ORIGINS`, type **Text**, value: `https://mrkodnghe.github.io` (optional; this is the default)
4. Open `https://route-relay.<your-subdomain>.workers.dev/health`. It should show `{"ok":true,"configured":true}`.
5. Put that address (without `/health`) in `RELAY` in `route-planner/index.html`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/directions/{profile}` | Route, body is an openrouteservice directions request |
| GET | `/geocode?text=…` | Find a place in Great Britain |
| POST | `/pois` | Cafés within 2 km of a point |
| GET | `/health` | Check the relay is set up |
