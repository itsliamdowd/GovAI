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

Env: `ANTHROPIC_API_KEY` (required), `PORT` (default 8787), `COUNCIL_MEETINGS` (recent meetings to ingest, default 30).

## How it works

- `server.js` — Node http server. Streams Claude (`claude-opus-5-5`) responses over SSE to the browser. Tools: `search_city_knowledge`, `query_dataset`, `search_council_meetings`, `web_search` (santamonica.gov only), `submit_application`, `check_application_status`.
- `rag.js` — BM25 index over `knowledge/*.md` chunks and the CKAN dataset catalog (titles, notes, tags, field names). `query_dataset` hits the CKAN datastore live.
- `council.js` — pulls City Council meetings from the Agendas & Minutes dataset, fetches agenda text (IQM2) and minutes (PDF → text), chunks and indexes them. Cached in `data/council/`.
- `public/` — single-page PWA (installable, dark mode, voice input, "My applications" tracker in localStorage).
- Applications persist to `data/applications.json`.
