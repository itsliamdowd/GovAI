# GovAI — Santa Monica city assistant

One chat front door to the City of Santa Monica: answers anything about city services, pulls live rows from
[data.santamonica.gov](https://data.santamonica.gov), searches City Council agendas and official minutes, and files
permit applications / 311 requests end to end.

## Run

```bash
cp .env.example .env          # put your Anthropic API key in .env
brew install poppler           # pdftotext, used to read council minutes PDFs (optional)
npm install
npm start                      # http://localhost:8787
npm test
```

Env: `ANTHROPIC_API_KEY` (required), `PORT` (default 8787), `COUNCIL_MEETINGS` (past meetings to ingest from the Agendas & Minutes dataset, default 1000 = all since 2015), `COUNCIL_YT_CHANNELS` (comma-separated YouTube channel ids to pull council meeting captions from; default covers every channel that has carried a meeting, back to July 2014).

## How it works

- `server.js` — Node http server. Streams Claude responses over SSE to the browser. Tools: `search_city_knowledge`, `query_dataset`, `search_council_meetings`, `web_search` (santamonica.gov only), `open_application_form`, `submit_application`, `check_application_status`, `create_alert`, `cancel_alert`. Sources shown under an answer are only knowledge chunks scoring near the top hit (each carries its section's `Source:` URL) plus datasets actually read via `query_dataset`.
- `forms.js` — predefined applications (block party, preferential parking, bulky pickup, business license, dog license, community event, 311). Each lists the information the city's own page asks for; the browser renders it as a step-by-step card (Next → Submit → ✓) and files it via `POST /api/applications`.
- `rag.js` — BM25 index over `knowledge/*.md` chunks and the CKAN dataset catalog (titles, notes, tags, field names). `query_dataset` hits the CKAN datastore live.
- `council.js` — pulls City Council meetings from the Agendas & Minutes dataset, fetches agenda text (IQM2) and minutes (PDF → text), chunks and indexes them. Cached in `data/council/`.
- `sources.js` — everything else Santa Monica (see below): local news feeds, city + county GIS layers, live federal/state/county APIs.
- `public/` — single-page PWA (installable, dark mode, voice input, "My applications" tracker in localStorage).
- Applications persist to `data/applications.json`.

## Sources

Beyond `knowledge/*.md`, the 82 data.santamonica.gov datasets and council agendas/minutes/transcripts, the assistant retrieves from:

- **Local news** (`search_local_news`, refreshed every 30 min, cached in `data/news.json`): Santa Monica Daily Press, Santa Monica Mirror, Santa Monica Next, Santa Monica Observer, Patch Santa Monica, Canyon News, LA Times California, r/SantaMonica, Bing News, Google News queries covering the Santa Monica Lookout, Westside Current, KCRW, LAist, city news releases, SMC/SMMUSD and local landmarks, plus Santa Monica CityTV meeting-video feeds (council and boards).
- **GIS layers** (`query_gis`, catalog cached in `data/gis.json`): ~200 City of Santa Monica layers from gis-smgov.opendata.arcgis.com (zoning, land use, parcels, preferential parking, street sweeping, bike network, trees, historic resources, hazard/evacuation zones, airport noise, transit stops, vote precincts, census geography…) and ~800 LA County eGIS layers, queryable by address (geocoded with Nominatim) or SQL `where`. County political-boundary layers answer "who represents this address".
- **Live & external** (`get_live_data`): NWS forecast/alerts, NOAA tides & water temp (Santa Monica Pier), USGS earthquakes, AirNow AQI, Heal the Bay beach grades, Lime scooter/bike availability (GBFS), Big Blue Bus GTFS-RT service alerts, OpenSky aircraft near SMO, Caltrans I-10/PCH cameras, CDC PLACES health estimates, BLS unemployment, LA County Assessor parcel records, Wikipedia, data.ca.gov datasets (query them with `query_dataset portal=california`), Census ACS profile (set `CENSUS_API_KEY`).
- **web_search** is allowed on city, county, state and local-news domains.

## Daily watch alerts

Say "track 1685 Main St" (or any topic). The assistant asks for an email and calls `create_alert`. Every morning (`ALERT_HOUR`, default 07:00 local) the server re-pulls council agendas/minutes/transcripts, gathers what the index and data.santamonica.gov say about each watched topic, diffs it against what was already seen, and asks a judge model (`JUDGE_MODEL`, default `claude-haiku-5-5`) one question: has something changed for this resident, yes or no. Yes: it compiles an email and sends it via Resend (`RESEND_API_KEY`, `ALERT_FROM`) or, with no key, writes it to `data/outbox/`. No: nothing happens. Run the check on demand: `curl -X POST localhost:8787/api/alerts/run`. Alerts live in `data/alerts.json`; `cancel_alert WATCH-XXXXXX` stops one.
