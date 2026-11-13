# Overhead Spotter

Point your phone at the sky and it names what's flying over you: aircraft, helicopters, satellites, planets and stars. Catches score points on a shared leaderboard.

Live at **https://spotter.ttcorp.ai** · club page **https://spotter.ttcorp.ai/club** · a TT Corporation product.

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| App | `public/index.html` | The whole web app (installable PWA) in one file: Point, Radar, Map, Nearby and Hangar views, logbook, share cards, Pick-up mode |
| Club page | `public/club/index.html` | Landing page friends get from the invite link, with install steps for iPhone and Android |
| Service worker | `public/sw.js` | Offline shell and push notifications |
| Place list | `public/places.json` | 2,328 airports and heliports (OurAirports, public domain) for takeoff and destination guesses |
| API | `netlify/functions/api.mjs` | Area log, track relay, push sign-up (watchlist, satellites, circling, Pick-up settings) |
| Leaderboard | `netlify/functions/club.mjs` | Join, sync and board; the club owner can remove players |
| 24/7 logger | `netlify/functions/log-traffic.mjs` | Every 2 minutes: logs aircraft around Portland, sends watchlist, emergency, fire, military, rare, circling and Pick-up alerts |
| Sky alerts | `netlify/functions/sky-alerts.mjs` | Every 10 minutes: ISS, Starlink, watched satellites, reentries and twilight Vandenberg launches |
| Flight path | `netlify/functions/trace.mjs` | Full track from takeoff via OpenSky (needs `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET`) |
| FAA owners | `.github/workflows/faa.yml` | Nightly GitHub job that turns the FAA registry into a lookup on the `faa-data` branch. City and state only, never street addresses |

## Data sources

adsb.fi and adsb.lol (live aircraft) · adsbdb (registration and routes) · OpenSky (tracks) · CelesTrak (satellite orbits and catalog) · Launch Library 2 (launches) · FAA Releasable Aircraft Database · OurAirports.

## Publishing

- Work lands on `main`. Netlify does **not** build `main`.
- Netlify publishes only the `live` branch. To publish, open a pull request from `main` into `live` (Netlify builds a free preview of it), then merge. One merge is one production deploy (15 credits).
- Commits that should never deploy can include `[skip netlify]` in the message.

## Settings (Netlify environment variables)

`AREA` (default `45.52,-122.68,25`: latitude, longitude, radius in nautical miles) · `AREA_TZ` (default `America/Los_Angeles`) · `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`.
