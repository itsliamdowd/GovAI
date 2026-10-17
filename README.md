# GovAI — local-government assistant (Santa Monica, San Diego County, Orange County)

One chat front door to local government. Santa Monica is fully wired (knowledge base, [data.santamonica.gov](https://data.santamonica.gov),
City Council agendas/minutes/transcripts, local news, GIS, live feeds, guided permit forms). Every city in San Diego County and
Orange County plus both county governments are in the registry (`jurisdictions.js`) and are being wired phase by phase.
The assistant works out which jurisdiction a resident means from the conversation (city name, neighborhood, ZIP, address) —
there is no picker — and scopes every search, tool, form and contact line to it.

## Jurisdictions

- `jurisdictions.js` is the registry: one entry per city/county (aliases for detection, centroid/bbox, open-data portals, council platform,
  YouTube channels, news feeds, GIS hubs, live-API ids, contact, forms, routing, web domains, confirmation prefix).
- Every indexed doc carries `jur`; `rag.search(...)` is scoped to the active jurisdiction + its county + the state.
- Caches live under `data/<jurisdiction>/` (`catalog-*.json`, `council/`, `transcripts/`, `news.json`, `gis.json`); knowledge under `knowledge/<jurisdiction>/`.
- `DEFAULT_JUR=santa-monica` pins a deployment to one city; unset, the server detects it per session and the model can call `set_jurisdiction`.
- Entries marked `draft: true` have no data wired yet: the assistant says so and falls back to web search on the jurisdiction's own domains.
- Wiring a jurisdiction: `node discover.js <id>` probes Legistar / Granicus / ArcGIS Hub / YouTube and prints registry fields to paste in;
  `node knowledge-gen.js <id>` drafts its `knowledge/<id>/*.md` from the city's own pages (needs `ANTHROPIC_API_KEY`); `node warm.js catalog`,
  `node warm.js council <id>`, `node warm.js transcripts <id>` collect the data. Council platforms supported today: `ckan-iqm2` (Santa Monica) and `legistar` (County of San Diego).
- Open-data portals supported: CKAN (query live), DCAT catalogs (ArcGIS Hub feeds, Socrata/SANDAG via SODA, the City of San Diego inventory whose CSV/JSON files are downloaded once, capped at 25 MB, and filtered locally).

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
- `rag.js` — incremental BM25 inverted index (stemmed unigrams + content bigrams) over `knowledge/*.md` chunks, the CKAN dataset catalog, council agendas/minutes/transcripts, GIS layers and news. `addDocs()` appends without rebuilding; search results are LRU-cached until docs change; `query_dataset` hits the CKAN datastore live with a capped 10-minute row cache. Everything indexes from committed `data/` at startup (~2.5 s for ~42k chunks).
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

## Data collection (maintainer only)

The server never collects data at runtime. It serves from the committed `data/` directory: open-data catalog, council agendas and minutes, meeting transcripts, GIS layer catalog, local news items. A fresh clone works offline against those files.

To refresh, run the collector on your own machine and commit the result:

```bash
node warm.js              # everything (CKAN catalog, IQM2 minutes, YouTube captions via yt-dlp, GIS, news)
node warm.js transcripts  # just one: catalog | council | transcripts | gis | news
git add data && git commit -m "refresh city data"
```

Needs `pdftotext` (poppler) for minutes and `yt-dlp` for captions. Setting `COLLECT=1` in `.env` makes a running server also refresh in the background (daily council re-pull before alerts, news every 30 minutes). Leave it unset anywhere else.

Per-request lookups still go live when a resident asks something (open-data rows, web search on santamonica.gov, GIS address queries, Big Blue Bus alerts). Those answer one question; they don't crawl.

Resident data (`applications.json`, `clips.json`, `alerts.json`, `feedback.jsonl`, `outbox/`) stays local and is gitignored.

## Daily watch alerts

Say "track 1685 Main St" (or any topic). The assistant asks for an email and calls `create_alert`. Every morning (`ALERT_HOUR`, default 07:00 local) the server re-pulls council agendas/minutes/transcripts, gathers what the index and data.santamonica.gov say about each watched topic, diffs it against what was already seen, and asks a judge model (`JUDGE_MODEL`, default `claude-haiku-5-5`) one question: has something changed for this resident, yes or no. Yes: it compiles an email and sends it via Resend (`RESEND_API_KEY`, `ALERT_FROM`) or, with no key, writes it to `data/outbox/`. No: nothing happens. Run the check on demand: `curl -X POST localhost:8787/api/alerts/run`. Alerts live in `data/alerts.json`; `cancel_alert WATCH-XXXXXX` stops one.
