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

## Official YouTube transcript ingestion

This optional offline importer covers **all uploads**, including archived livestreams, from:

| Channel | Channel ID |
| --- | --- |
| City of Santa Monica / CityTV | `UC4V0jOEL4JMCcElkGA7AJpA` |
| Santa Monica Police Department | `UCyq1UTKGqCmUtsJi984yF5A` |

The app is Node-based and has no Python dependency manager or database. The importer uses an
optional `requirements-youtube.txt` and the same `data/` file-cache pattern as the other sources.
It does not replace the existing council-only `yt-dlp` importer or change other feeds.

### Setup and run

Use Python 3.10+ and the Node version used by the app (Node 22+ recommended).
Enable **YouTube Data API v3** in your Google Cloud project, create an API key, and put
`YOUTUBE_API_KEY=your-key` in your local `.env` (or export it in the environment).
Keep this key server-side. `.env` and generated `data/` are gitignored.

```bash
python3 -m venv .venv
source .venv/bin/activate           # Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements-youtube.txt
npm run ingest:youtube             # loads .env; all pages, both channels

# Small first run (limit applies to each channel):
npm run ingest:youtube -- --max-videos 3
# One channel, prefer English then Spanish captions:
npm run ingest:youtube -- --channel-id UCyq1UTKGqCmUtsJi984yF5A --languages en,es
# Force a refresh of successful captions too:
npm run ingest:youtube -- --refresh-transcripts
# Increase spacing between individual caption HTTP requests:
npm run ingest:youtube -- --request-delay 15
```

On Windows set `PYTHON=python` in `.env` if `python3` is unavailable. When calling
`python -m scripts.ingest_youtube` directly, export `YOUTUBE_API_KEY` yourself; Python does
not load `.env`. `--data-dir PATH` overrides output for standalone uses; the app reads the
default `data/youtube/` directory. No Anthropic key is needed to run this importer.

### Data flow and stored schema

`scripts/ingest_youtube.py` calls `channels.list(part="snippet,contentDetails")` for official
channel metadata and the uploads playlist, paginates `playlistItems.list` with 50 items per
page, and hydrates title, description, publication date and availability with `videos.list`
in batches. It never uses `search.list` or the authenticated captions download API.
Public original-language captions come from `youtube-transcript-api` (manual preferred over
generated within each requested language; other original languages used as a fallback).
Auto-generated tracks are retained and flagged. There is no automatic translation.

- `data/youtube/channels/<channel_id>.json`: official channel metadata.
- `data/youtube/records/<video_id>.json`: canonical per-video checkpoints, atomically replaced.
- `data/youtube/videos.jsonl`: one deduplicated video record per line, including failed/unavailable videos.
- `data/youtube/chunks.jsonl`: one retrieval chunk per line, built from available transcripts only.

Video records contain `video_id`, `youtube_url`, `channel_id`, official `channel_name`,
`configured_channel_name`, `title`, `description`, `published_at` (nullable for unavailable
uploads), `video_available`, `transcript_available`, normalized `transcript_text`, and
`transcript_segments: [{text, start, duration}]`. Times are seconds with fractional precision.
They also contain `transcript_language`, `transcript_is_generated`, `transcript_checked_at`,
`transcript_status`, `transcript_error` (exception class, no raw request URLs), and `updated_at`.
Missing captions leave empty text/segments and `transcript_available: false`; errors are
classified as disabled, no_captions, unavailable, blocked, empty, or error.

Chunks have deterministic `chunk_id` (`video_id:ordinal`), video/channel IDs and names, video
title, publication date, language/generated flag, text, `start`, `end`, base `youtube_url` and
timestamped `url`. Chunking targets at most 250 whitespace-separated words, retaining caption
boundaries and up to 35 words of overlap. Long individual cues are split without inventing
word-level timestamps: their pieces retain the enclosing cue times. Chunks are based on text
size, not fixed time intervals.

`youtube.js` adapts these chunks to the existing BM25 document format. **Restart the app after
ingestion** to load them through `rag.js`; they appear in `search_city_knowledge` with source
links and caption provenance (`kind: youtube_video`). Existing council search keeps its current
behavior. Cited timestamped clips can also read the new per-video cache. Captions are source
material and may contain transcription errors; they are not authoritative minutes or policy.

### Repeated runs and failures

`video_id` is the stable key. Every run refreshes video/channel metadata, reuses successful
captions, and retries videos with missing/failed captions. `--refresh-transcripts` retries
successful captions; a failed refresh preserves the last usable transcript and records the
failure under `last_refresh_status/error/at`. Private/deleted videos returned by the uploads
playlist keep metadata (last known fields where available). Existing records are not removed
just because an upload disappears from a later playlist listing.

Each video is checkpointed before continuing. JSONL snapshots are rebuilt atomically, one file
at a time, at the end of the run, including partial runs with channel failures. Re-running after
an interruption resumes using saved records and regenerates chunks without duplicates or stale
chunks. The CLI rejects concurrent importers using `data/youtube/.ingest.lock`; after a hard kill,
verify no importer is running before removing that lock. Do not run multiple writers on different
machines against the same directory. Use persistent disk if running on ephemeral hosting.

YouTube API calls have 30-second timeouts and up to three client-library retries. A metadata/API
failure stops that channel, continues with the next, exports saved results and returns exit code 1.
A normal caption failure affects only that video and is recorded; other videos continue. An IP
block (`IpBlocked`/`RequestBlocked`) or HTTP 429 stops the run across both channels after saving
the current record. Exit code **2** and `"paused": true` mean the import is incomplete; the summary
includes a UTC `retry_after`. Check `transcript_status` in `videos.jsonl` when assessing coverage.
YouTube may block public-caption requests from cloud or other IPs; this is recorded as a failure
rather than pretending the video has no captions. No proxy, cookies, or ownership credentials
are required by this code.

Every caption HTTP request (including the separate requests to list and fetch captions) is paced
with a default **10-second minimum interval**. Set `YOUTUBE_REQUEST_DELAY_SECONDS=15` in `.env`
or pass `--request-delay 15` to slow it further. This is a conservative starting value, not an
official allowed rate or a guarantee against blocking. Ordinary Google Data API requests use the
existing client retries and are separate from caption pacing.

After a block, `data/youtube/request-state.json` persists a circuit-breaker cooldown: initially
**30 minutes**, doubling on repeated blocked runs up to **24 hours** (a longer server `Retry-After`
is honored). Configure the initial duration with `YOUTUBE_BLOCK_COOLDOWN_SECONDS` or
`--block-cooldown` (seconds). Restarting during this cooldown makes **no YouTube requests** and
returns exit code 2. After it expires, rerun the same command to resume, reusing downloaded captions.
An uninterrupted completed run resets the escalating cooldown count. Keep the request-state file
along with the transcript cache; removing it to retry immediately defeats this protection.
Ctrl+C during ingestion exports saved records and releases the lock through Python's cleanup;
a forced process kill can still leave the lock behind. There is no automatic unbounded retry loop.
The initial import can be slow; no whole-channel ingest is started inside an HTTP request or at
server startup. Schedule the CLI externally if regular refreshes are needed.

### Validation

```bash
npm run test:youtube       # offline Python importer tests + Node cache/RAG adapter tests
npm test                  # existing app checks (also start background network sources)
```

Tests cover paginated uploads, video hydration, metadata retention, missing/failed/auto captions,
language selection, idempotent re-runs, successful-caption reuse, failed-refresh preservation,
bounded overlapping chunks and precise times, channel isolation, lock/path safety, BM25 loading,
per-request pacing, HTTP Retry-After, stop-on-block, persisted/exponential cooldowns, resume,
and interrupt cleanup.
Live ingestion requires a real YouTube API key and network access to YouTube.

## Sources

Beyond `knowledge/*.md`, the 82 data.santamonica.gov datasets and council agendas/minutes/transcripts, the assistant retrieves from:

- **Local news** (`search_local_news`, refreshed every 30 min, cached in `data/news.json`): Santa Monica Daily Press, Santa Monica Mirror, Santa Monica Next, Santa Monica Observer, Patch Santa Monica, Canyon News, LA Times California, r/SantaMonica, Bing News, Google News queries covering the Santa Monica Lookout, Westside Current, KCRW, LAist, city news releases, SMC/SMMUSD and local landmarks, plus Santa Monica CityTV meeting-video feeds (council and boards).
- **GIS layers** (`query_gis`, catalog cached in `data/gis.json`): ~200 City of Santa Monica layers from gis-smgov.opendata.arcgis.com (zoning, land use, parcels, preferential parking, street sweeping, bike network, trees, historic resources, hazard/evacuation zones, airport noise, transit stops, vote precincts, census geography…) and ~800 LA County eGIS layers, queryable by address (geocoded with Nominatim) or SQL `where`. County political-boundary layers answer "who represents this address".
- **Live & external** (`get_live_data`): NWS forecast/alerts, NOAA tides & water temp (Santa Monica Pier), USGS earthquakes, AirNow AQI, Heal the Bay beach grades, Lime scooter/bike availability (GBFS), Big Blue Bus GTFS-RT service alerts, OpenSky aircraft near SMO, Caltrans I-10/PCH cameras, CDC PLACES health estimates, BLS unemployment, LA County Assessor parcel records, Wikipedia, data.ca.gov datasets (query them with `query_dataset portal=california`), Census ACS profile (set `CENSUS_API_KEY`).
- **web_search** is allowed on city, county, state and local-news domains.

## Daily watch alerts

Say "track 1685 Main St" (or any topic). The assistant asks for an email and calls `create_alert`. Every morning (`ALERT_HOUR`, default 07:00 local) the server re-pulls council agendas/minutes/transcripts, gathers what the index and data.santamonica.gov say about each watched topic, diffs it against what was already seen, and asks a judge model (`JUDGE_MODEL`, default `claude-haiku-5-5`) one question: has something changed for this resident, yes or no. Yes: it compiles an email and sends it via Resend (`RESEND_API_KEY`, `ALERT_FROM`) or, with no key, writes it to `data/outbox/`. No: nothing happens. Run the check on demand: `curl -X POST localhost:8787/api/alerts/run`. Alerts live in `data/alerts.json`; `cancel_alert WATCH-XXXXXX` stops one.
