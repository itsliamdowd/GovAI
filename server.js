import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { buildIndex, queryDataset, PORTALS } from "./rag.js";
import { JURS, SERVED, jurById, detect, contextFor, countyOf, nearest } from "./jurisdictions.js";
import { ingestCouncil, loadCouncilCache } from "./council.js";
import { ingestTranscripts, loadTranscriptCache, clipWindow, citedMoments } from "./transcripts.js";
import { createAlert, cancelAlert, runAlerts } from "./alerts.js";
import { loadTTS, speakWav } from "./tts.js";
import { FORMS, FORM_TYPES, formsFor, formFor, toApplication } from "./forms.js";
import { ingestNews, loadNewsDocs, loadGisCatalog, gisDocs, gisJurs, feedsFor, queryGis, liveData, LIVE_KINDS, LIVE_HELP } from "./sources.js";
import { loadAddresses, suggestAddresses } from "./addresses.js";
import { councilJurs } from "./council.js";
import { transcriptJurs } from "./transcripts.js";

const PORT = Number(process.env.PORT) || 8787;
const APPS_FILE = "./data/applications.json";
const STAFF_CODE = process.env.STAFF_CODE || "planning"; // ponytail: one shared code gates /api/staff/*; swap for SSO when real staff use it
const STATUSES = ["received", "in_review", "needs_info", "approved", "denied"];
try { process.loadEnvFile(); } catch {} // load .env ourselves so `node server.js`, warm.js, one-off scripts and tests all work without --env-file
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("Missing ANTHROPIC_API_KEY. Add a line ANTHROPIC_API_KEY=sk-ant-... to the .env file in the project root (no quotes, no spaces around =), then restart npm run dev.");
  process.exit(1);
}
const client = new Anthropic();
// Default is Sonnet: the "Hackathon" workspace caps claude-opus-5-5 at 1 input token/min, so Opus 429s on every call.
// Raise that limit in console.anthropic.com → Settings → Limits, then set MODEL=claude-opus-5-5 in .env.
const MODEL = process.env.MODEL || "claude-sonnet-5-5";

// Background collectors (council/news/GIS/TTS) must never take the HTTP server down: log and keep serving.
process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
const rag = await buildIndex();
console.log(`RAG index ready: ${rag.datasetCount} open datasets indexed`);
// Collection policy: the server reads committed data/ only. Nothing is pulled from CKAN, IQM2, YouTube, GIS or news
// feeds at runtime unless COLLECT=1 (the maintainer's machine). `node warm.js` is the explicit collector.
const COLLECT = process.env.COLLECT === "1";
// Council/board records per jurisdiction: { ready, ingested, upcoming, transcripts }
const SM = jurById("santa-monica");
const councils = new Map();
const councilOf = (jur) => councils.get(jur) ?? { ready: false, ingested: [], upcoming: [], transcripts: 0 };
for (const j of new Set([...councilJurs(), ...transcriptJurs()])) {
  const c = loadCouncilCache(j), t = loadTranscriptCache(j);
  rag.addDocs([...c.docs, ...t.docs]);
  councils.set(j.id, { ready: c.meta.ingested.length > 0, ...c.meta, transcripts: t.count });
  console.log(`Council ${j.id} (from data/): ${c.meta.ingested.length} meetings, ${c.docs.length} chunks; transcripts: ${t.count} meetings, ${t.docs.length} chunks`);
}
if (!councils.size) console.log("No council records on disk - run `node warm.js` to collect");
console.log(`Addresses (from data/): ${loadAddresses()} official address points for autocomplete`);
function refreshCouncil() {
  if (!COLLECT) return Promise.resolve();
  return Promise.all(SERVED.flatMap((j) => [
    j.council?.platform && ingestCouncil((docs, meta) => { rag.addDocs(docs); councils.set(j.id, { ...councilOf(j.id), ready: true, ...meta }); console.log(`Council ${j.id}: ${meta.ingested.length} meetings (agendas+minutes), ${docs.length} chunks indexed`); }, console.error, j)
      .catch((e) => console.error(`council ingestion failed (${j.id}):`, e.message)),
    j.youtube?.length && ingestTranscripts((docs, videos) => { rag.addDocs(docs); councils.set(j.id, { ...councilOf(j.id), transcripts: videos.filter((v) => docs.some((d) => d.url.includes(v.id))).length }); console.log(`Transcripts ${j.id}: ${docs.length} chunks indexed`); }, console.error, j)
      .catch((e) => console.error(`transcript ingestion failed (${j.id}; is yt-dlp installed?):`, e.message)),
  ].filter(Boolean)));
}
if (COLLECT) refreshCouncil();
// Daily watch: re-pull council records, then diff + judge + email each alert. ALERT_HOUR local, default 07:00.
const runWatch = () => refreshCouncil().then(() => runAlerts(rag)).catch((e) => console.error("alert run failed:", e.message));
function scheduleDaily(fn) {
  const now = new Date(), next = new Date(now); next.setHours(Number(process.env.ALERT_HOUR ?? 7), 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { fn(); setInterval(fn, 864e5).unref(); }, next - now).unref();
  console.log(`Daily watch scheduled for ${next.toLocaleString()}`);
}
scheduleDaily(runWatch);
if (process.env.TTS !== "off") loadTTS().then(() => console.log("TTS ready: Kokoro-82M (local)")).catch((e) => console.error("TTS unavailable, voice mode will use the browser voice:", e.message));
// City + county GIS layers become searchable "gis" docs; local news is pulled now and every 30 minutes.
let gisCount = 0;
for (const j of gisJurs()) loadGisCatalog(console.error, COLLECT, j).then((layers) => { rag.addDocs(gisDocs(layers)); gisCount += layers.length; console.log(`GIS ${j.id} (from data/): ${layers.length} layers indexed`); }).catch((e) => console.error(`gis catalog failed (${j.id}):`, e.message));
let news = { total: 0, feeds: 0 };
const newsJurs = SERVED.filter((j) => feedsFor(j).length);
for (const j of newsJurs) { const n = rag.addDocs(loadNewsDocs(j)); news.total += n; } // index cached articles now; ingestNews only emits items new since the last run
// ponytail: all jurisdictions' feeds every 30 min; round-robin one jurisdiction per minute if the feed count gets large
const refreshNews = () => Promise.all(newsJurs.map((j) => ingestNews((docs, meta) => { rag.addDocs(docs); news = { total: news.total + meta.fresh, feeds: meta.feeds }; console.log(`News ${j.id}: ${meta.fresh} new, ${meta.total} total items from ${meta.feeds} feeds`); }, console.error, j).catch((e) => console.error(`news ingestion failed (${j.id}):`, e.message))));
if (COLLECT) { refreshNews(); setInterval(refreshNews, 30 * 60e3).unref(); }

const SYSTEM = `You are GovAI, the local-government assistant for Southern California: every city and county in Los Angeles, Orange and San Diego counties. One front door to every city and county service, like america.gov but local.

Jurisdiction (hard rule)
- Every answer is about ONE active jurisdiction (a city or a county). The block after this prompt says which is active now, what records exist for it, and how to reach it. The server also switches it automatically when the resident names a covered city, county, neighborhood or ZIP.
- If none is active and the question depends on where the resident is, ask exactly one short question ("Which city are you in? An address works too.") and call no search tools until it is set. Call set_jurisdiction the moment you know (from a city name, address, ZIP, neighborhood or "my city is…"); it returns the jurisdiction's context.
- If the resident names another covered place, switch with set_jurisdiction and answer for it. County functions (assessor/property tax, vital records, public health permits, elections, courts, Sheriff, Board of Supervisors, unincorporated areas) belong to the county, whose records are already in scope for its cities; switch to the county itself only when they ask about the county government or an unincorporated area.
- Places outside these three counties (Ventura, Riverside, San Bernardino, other states): say you don't cover them and name the nearest covered one if useful.

What you do
- Answer anything about the active jurisdiction's government, services, permits, fees, rules, departments, parks, transit, trash, parking, housing, council or board, open data, and how to get things done.
- Take permit and service applications. Guided form cards exist in every jurisdiction for: ${FORM_TYPES.join(", ")} (in Santa Monica the card is the exact city process; elsewhere it collects the common fields and files with that city, which confirms fees and documents on review). When a resident wants to apply for, request, or report one of these where a form exists (including "how do I get a block party permit", a pothole, a missed pickup): call search_city_knowledge, then call open_application_form with the type, then END YOUR TURN WITH NO TEXT. The card is the whole reply: it shows the fee, deadline, what they need and the official page, and collects the details. Anything you write after opening a card is not displayed. Never ask in chat for the fields the form collects (name, email, phone, address, dates, etc.) and never call submit_application for a form type; the card submits it and you will see the confirmation number in the conversation afterwards.
- For types with no form (film_permit, encroachment_permit, temporary_use_permit, sidewalk_vending_permit, home_share_license, alarm_permit, other): collect only the required fields through a natural conversation (one or two questions at a time), confirm a summary, then call submit_application and end your turn with no text: the confirmation card shows the number, the department and next steps, and any text after it is not displayed.
- Look up application status with check_application_status when given a confirmation number.
- Whenever the answer points the resident to an office, department, hotline, counter or person (311, a permit center, a council office, a county department, a hotline), call show_contact with the details you have verified from an official page, then say in one line who it is and why. The card carries the phone, email, address, hours and link; don't repeat them in the text. One card per contact, at most two per reply.
- Set up a daily watch when a resident wants to be told if something changes: "track 1685 Main St", "let me know if council talks about the pier", "alert me when my block's parking rules change". Ask for their email (and the address if the topic is a place), restate what will be watched and explain it BEFORE calling: it's checked every morning against council agendas/minutes/transcripts and the city's open data, and they only get an email when something new actually concerns their topic. Then call create_alert and end your turn with no text; the watch card confirms it and any text after it is not displayed. cancel_alert stops it (number format WATCH-XXXXXX).

How you find answers (retrieval first, always)
1. Call search_city_knowledge with the resident's question before answering anything factual. It returns the most relevant city knowledge chunks AND matching open datasets (with resource_ids and field names).
2. If a dataset can answer (fees, active permits, business licenses, police/fire calls, rents, parking rates, trees, EV chargers, budget, campaign finance, water, etc.), call query_dataset with the resource_id and a full-text q or filters, then answer from the rows.
3. For anything about the City Council or Board of Supervisors: what was decided, who voted how, what's on an agenda, what a member or speaker actually said, upcoming meetings - call search_council_meetings. It searches the active jurisdiction's agendas, official minutes and meeting transcripts (YouTube captions where recordings exist; Santa Monica back to 2014–2015) and returns dated excerpts with links; the context block says what is indexed. Use doc="minutes" for votes/decisions, doc="transcript" for quotes/what was said, empty for both. Quote dates; cite the minutes link or the timestamped video link. When you quote or paraphrase something said in a meeting, include the transcript excerpt's exact url (the youtube link with &t=) as a markdown link - the app turns it into a playable clip of that moment. Transcripts are auto-captions and may misspell names.
4. For what's happening in town - news, controversies, crime, closures, openings, elections, school districts, what residents are saying - call search_local_news. It searches the jurisdiction's local outlets, news-wire queries and meeting-video feeds (Santa Monica: Daily Press, Mirror, Next, Observer, Lookout, Westside Current, Patch, LA Times, KCRW, LAist, city releases, CityTV, r/SantaMonica), refreshed every 30 minutes. Give the date and the publisher in the text ("the Daily Press reported on Oct 12 that…"); reporting is not city policy, say which it is.
5. Location (hard rule): when a question is about the resident's own place ("my street", "near me", "where I am", "my zoning", "my supervisor") and they gave no address, do NOT ask for one - call the tool with an empty address/query; the server fills in their device location and the result says "your current location". Only ask for an address if the tool reports that no device location is available.
6. For anything about a specific place or address - zoning, land use, preferential parking zone and rules, street sweeping day, bike lanes, nearby trees, historic status, fault/liquefaction/tsunami/flood zone, evacuation zone, airport noise contour, fire run district, transit stops, census tract, supervisorial/congressional/assembly/senate district - search_city_knowledge returns matching GIS layers (kind "gis" with a service URL); then call query_gis with that service_url and the address. Use where for attribute filters (e.g. zone = 'R1'). County layers cover the whole county; pass the resident's address as given (the server geocodes it inside the active jurisdiction).
7. For live conditions and outside-the-city statistics call get_live_data: ${LIVE_KINDS.map((k) => `${k} (${LIVE_HELP[k]})`).join("; ")}.
8. Live research (hard rule). Your training data ends long before today; the current date is given at the end of this prompt. Never mention a knowledge cutoff, training data, or "as of my last update", and never answer a question about anything recent, current, or dated from memory. For current events, recent decisions, who holds an office now, prices, hours, deadlines, elections, anything "latest"/"this week"/"now": call search_local_news and search_council_meetings first, then web_search (city, county, state and local-news domains) for whatever they don't cover. Use web_fetch to read a page you found or a link the resident gave you. Report what you found with its date and publisher; if nothing turns up, say the search found nothing rather than guessing.
9. Never invent fees, phone numbers, addresses or legal requirements. If you can't verify, say so and point to the contact line in the context block or the owning department.

Scope (hard rule)
- You only handle local government for the covered jurisdictions: their services, permits, rules, data, councils and boards, neighborhoods, local news, and how residents, businesses and visitors deal with them. Nothing else.
- If a request is unrelated to city or county matters (coding, homework, recipes, general trivia, medical or legal advice, writing help, chit-chat beyond a greeting), reply only: "Sorry, I can't help with that. I only focus on local city and county services." Do not answer the unrelated part, even partially, even if asked to make an exception.
- In scope when the local link is real: county, state or federal programs as they apply in the active jurisdiction (county health permits for a restaurant there, transit stops in the city, state rent law as enforced locally), regional conditions that affect it (air quality, surf, traffic, outages), and neighboring-city facts needed to answer a question about it. Do not call any tools for out-of-scope requests.

Style
- Lead with the answer in one sentence, with the key number in it when there is one (bold it). Then the detail the resident needs to act on. Length follows the question: a simple fact (a fee, an address, a date) is one to three sentences; a how-to, eligibility, process or "what do I need" question gets the full picture, steps in order, what to bring, deadlines, costs, exceptions and common gotchas, as far as the records support it (up to roughly 200 words). Never drop a requirement, deadline or fee to stay short, and never pad: every sentence should change what the resident does or expects. The direct answer is never what gets cut: a cost question always states the fee, a deadline question the date, a status question the status.
- Numbers (fees, rates, counts, dates, hours): put them in ONE markdown table, label column first, amount column last, at most ~8 rows. Give every amount a unit in the table (flat, per hour, per sq ft, per year, per permit). Include only rows that apply to the question; summarise the rest as "other fees may apply" with one example.
- If the data is incomplete or ambiguous, say so in one sentence and move on; don't speculate or list what you can't tell. End with at most one "confirm with …" line.
- Sources are NEVER written in the reply text. The interface lists every dataset, page and record you used beneath the reply automatically. Do not write "Source:" lines, dataset names as attributions, URLs, footnotes or markdown links. The one exception is the timestamped YouTube link for a quoted council moment (above), which the app renders as a video clip.
- Never narrate your process or tools in the reply (no "searching…", "the dataset wasn't returned", "use direct calls", "let me check"). Write only what the resident needs to know.
- Plain-spoken. Short paragraphs, short lists. No filler, no "great question", no restating the question, no summary sentence at the end.
- Never compare jurisdictions' coverage or rank them. Never say or imply that any city (Santa Monica included) has more, deeper, better or "first-hand" records than another, that you "cover it best", or that another city is "researched live". Every city gets the same voice: answer what you found, and if something isn't available for that city, say where to get it there.
- You are a city information and intake service, not a lawyer. For disputes (evictions, citation appeals) explain the process and the office.
- When a resident describes a problem that 311 handles (pothole, missed pickup, graffiti, streetlight), open the 311_service_request form with open_application_form.

Applications
Types for submit_application (anything without a guided form in the active jurisdiction): building_permit, business_license, community_event_permit, block_party_permit, film_permit, encroachment_permit, preferential_parking_permit, temporary_use_permit, sidewalk_vending_permit, home_share_license, dog_license, alarm_permit, bulky_item_pickup, 311_service_request, other. A block party on a public street is block_party_permit (in Santa Monica its own simpler process, $100.95), not a community event permit.
Required for every application: applicant_name, email, phone. Collect address (project/event/service location) for everything except business_license (use business address) and dog_license (owner address). Ask for a date when the permit is time-bound (events, film, encroachment, pickups). Put everything else the department would need in details (event: attendance, venue, street closure, alcohol, amplified sound; building: scope, contractor, valuation; film: company, crew size, equipment, locations).`;

// web_search / web_fetch are allowed on the active jurisdiction's own domains + its county's + shared civic/news domains.
const COMMON_DOMAINS = ["ca.gov", "en.wikipedia.org", "patch.com", "governmentjobs.com", "healthebay.org", "kcrw.com", "laist.com", "kpbs.org", "voiceofsandiego.org", "voiceofoc.org", "legistar.com", "granicus.com"];
const BLOCKS_CRAWLER = new Set(["latimes.com", "ocregister.com", "sandiegouniontribune.com"]); // sites that block Anthropic's fetcher: the API rejects them in allowed_domains
const domainsFor = (j) => [...new Set([...(j?.domains ?? SM.domains), ...(jurById(j?.county)?.domains ?? []), ...COMMON_DOMAINS])].filter((d) => !BLOCKS_CRAWLER.has(d));
// A jurisdiction without curated knowledge gets the open web (its services often live on contractor sites: trash haulers, permit
// portals, transit agencies); the prompt tells the model to prefer official and contracted-provider pages. Fully wired ones stay fenced.
const webScope = (j) => (!j || j.draft ? {} : { allowed_domains: domainsFor(j) });
// Only the tools that file records are `strict` (exact enums/required fields matter there). Strict schemas compile to grammars that
// count against a per-request complexity cap, and 12 of them tipped it ("Schema is too complex"). Handlers default any field the model omits.
const tools = [
  {
    name: "search_city_knowledge",
    description: "Retrieve the most relevant knowledge chunks, open datasets and GIS layers for the active jurisdiction (plus its county and the state). Call this first for any factual question.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Natural-language question or keywords." } },
      required: ["query"], additionalProperties: false,
    },
  },
  {
    name: "query_dataset",
    description: "Query rows from an open-data dataset resource (CKAN datastore; the dataset's portal comes from search_city_knowledge). Use resource_id from search_city_knowledge. q is full-text search across all fields; filters is a JSON object string of exact field matches, e.g. {\"department\":\"Public Works\"}; sort like \"fee desc\".",
    input_schema: {
      type: "object",
      properties: {
        resource_id: { type: "string" },
        q: { type: "string", description: "Full-text search terms, or empty string." },
        filters: { type: "string", description: "JSON object of exact matches, or empty string." },
        sort: { type: "string", description: "e.g. \"fee desc\", or empty string." },
        limit: { type: "integer", description: "Rows to return, 1-100." },
        portal: { type: "string", enum: ["santamonica", "california"], description: "Which CKAN portal the resource_id belongs to: data.santamonica.gov (default) or data.ca.gov (resource_ids from get_live_data ca_open_data)." },
      },
      required: ["resource_id", "q", "filters", "sort", "limit", "portal"], additionalProperties: false,
    },
  },
  {
    name: "search_local_news",
    description: "Search local news and community coverage about Santa Monica (Daily Press, Mirror, Next, Observer, Lookout, Westside Current, Patch, LA Times, KCRW, LAist, city news releases, CityTV meeting videos, r/SantaMonica). Returns dated articles with publisher, link and excerpt.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        days: { type: "integer", description: "Only items from the last N days; 0 for all time." },
      },
      required: ["query", "days"], additionalProperties: false,
    },
  },
  {
    name: "query_gis",
    description: "Query a city or county GIS layer (ArcGIS REST). Pass the layer's service_url from a search_city_knowledge 'gis' result. address finds the feature(s) at that address (polygon layers: the containing zone; point/line layers: within 250 m); with an empty address the resident's device location is used when available. where is an ArcGIS SQL filter on the layer's fields, or empty. Returns the layer's fields and matching records.",
    input_schema: {
      type: "object",
      properties: {
        service_url: { type: "string", description: "e.g. https://gis.santamonica.gov/server/rest/services/Zoning/FeatureServer/2" },
        address: { type: "string", description: "Street address in the active jurisdiction, or empty string. Empty + a device location = the resident's current spot." },
        where: { type: "string", description: "ArcGIS SQL where clause, or empty string." },
        limit: { type: "integer", description: "Max records, 1-100." },
      },
      required: ["service_url", "address", "where", "limit"], additionalProperties: false,
    },
  },
  {
    name: "get_live_data",
    description: `Fetch live or external data about Santa Monica. kind is one of: ${LIVE_KINDS.map((k) => `${k} - ${LIVE_HELP[k]}`).join("; ")}.`,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: LIVE_KINDS },
        query: { type: "string", description: "Address (property, scooters), topic (wikipedia), keywords (ca_open_data); empty string otherwise." },
      },
      required: ["kind", "query"], additionalProperties: false,
    },
  },
  {
    name: "search_council_meetings",
    description: "Search the active jurisdiction's council or board agendas, official minutes and meeting transcripts (YouTube captions). Returns dated excerpts with links (minutes PDF, agenda page, or timestamped video) plus upcoming meeting dates. Use for votes, decisions, agenda items, public hearings, what members or public speakers said.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        year: { type: "string", description: "Optional 4-digit year to restrict to, or empty string." },
        doc: { type: "string", enum: ["", "agenda", "minutes", "transcript"], description: "Restrict to one record type, or empty string for a mix." },
      },
      required: ["query", "year", "doc"], additionalProperties: false,
    },
  },
  {
    name: "set_jurisdiction",
    description: "Set (or switch) the city or county the conversation is about, once you know it from the resident's words, an address, a ZIP or a neighborhood. Returns that jurisdiction's context (records, forms, contacts). Call it before any search tool when no jurisdiction is active.",
    input_schema: { type: "object", properties: { jurisdiction: { type: "string", description: "The city or county: a registry id (santa-monica, san-diego, irvine, orange-county, san-diego-county…) or its plain name. Unknown places are rejected." } }, required: ["jurisdiction"], additionalProperties: false }, // ponytail: no enum - 140+ ids trips the API's schema-complexity limit
  },
  {
    name: "submit_application",
    description: "File a permit application or service request with the active jurisdiction. Only call after the applicant has confirmed the summarized details. Returns a confirmation number.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["building_permit", "business_license", "community_event_permit", "block_party_permit", "film_permit", "encroachment_permit", "preferential_parking_permit", "temporary_use_permit", "sidewalk_vending_permit", "home_share_license", "dog_license", "alarm_permit", "bulky_item_pickup", "311_service_request", "other"] },
        applicant_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        address: { type: "string", description: "Location the permit/request concerns. Empty string if not applicable." },
        requested_date: { type: "string", description: "ISO date (YYYY-MM-DD) or empty string." },
        summary: { type: "string", description: "One sentence describing the request." },
        details: { type: "string", description: "All other collected information, as readable text." },
      },
      required: ["type", "applicant_name", "email", "phone", "address", "requested_date", "summary", "details"],
      additionalProperties: false,
    },
  },
  {
    name: "create_alert",
    description: "Start a daily watch on a topic or address. Every morning the city's council records and open data are re-checked; the resident is emailed only when something new concerns the topic. Call after they confirm the topic and give an email.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What to watch, in the resident's words, e.g. 'any council action or permits for 1685 Main St' or 'pier parking rates'." },
        address: { type: "string", description: "Street address if the topic is a place, else empty string." },
        email: { type: "string" },
        name: { type: "string", description: "Resident's name or empty string." },
      },
      required: ["topic", "address", "email", "name"], additionalProperties: false,
    },
  },
  {
    name: "cancel_alert",
    description: "Stop a daily watch by its WATCH-XXXXXX number.",
    input_schema: { type: "object", properties: { confirmation_number: { type: "string" } }, required: ["confirmation_number"], additionalProperties: false },
  },
  {
    name: "open_application_form",
    description: "Show the resident a step-by-step application card for a predefined permit or service request. The card collects the city's required information and files the application itself. Call this instead of asking for applicant details in chat.",
    strict: true,
    input_schema: { type: "object", properties: { type: { type: "string", enum: FORM_TYPES } }, required: ["type"], additionalProperties: false },
  },
  {
    name: "show_contact",
    description: "Show the resident a contact card (tap-to-call, email, directions) for an office, department, hotline or person. Call this whenever you point someone to a contact instead of writing the phone or email in the text. Only include details verified from an official page; omit unknown fields; never invent a number.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "Office, department, hotline or person" },
      role: { type: "string", description: "What they handle, one short phrase" },
      phone: { type: "string" }, email: { type: "string" }, address: { type: "string", description: "Street address incl. city" }, hours: { type: "string" }, url: { type: "string", description: "Official page" },
      note: { type: "string", description: "One line of advice for the call" },
    }, required: ["name"] },
  },
  {
    name: "check_application_status",
    description: "Look up a previously filed application by confirmation number (format XX-XXXXXX, e.g. SM-123456).",
    input_schema: { type: "object", properties: { confirmation_number: { type: "string" } }, required: ["confirmation_number"], additionalProperties: false },
  },
];

// Per-jurisdiction tool list: web_search / web_fetch carry that jurisdiction's domains and location. Memoized per id.
const toolSets = new Map();
function toolsFor(j) {
  const key = j?.id ?? "";
  if (!toolSets.has(key)) toolSets.set(key, [...tools,
    { type: "web_search_20260209", name: "web_search", max_uses: 5, ...webScope(j), user_location: { type: "approximate", city: j?.short ?? "Santa Monica", region: "California", country: "US" } },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3, ...webScope(j), citations: { enabled: true }, max_content_tokens: 20000 },
  ]);
  return toolSets.get(key);
}

// ponytail: JSON file store; swap for a DB when more than one server instance exists.
function loadApps() { try { return JSON.parse(fs.readFileSync(APPS_FILE, "utf8")); } catch { return {}; } }
function saveApps(apps) { fs.mkdirSync(path.dirname(APPS_FILE), { recursive: true }); fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2)); }
const GENERIC_ROUTING = (j) => ({ other: [j.contact?.name ?? j.name, `Routed to the responsible ${j.kind} department; reach ${j.contact?.line ?? "the main line"} for status.`] });
const routingFor = (j) => ({ ...GENERIC_ROUTING(j), ...(j.routing ?? {}) });
const ROUTING = routingFor(SM); // Santa Monica table (staff desk departments list)
export function submitApplication(input, j = SM) {
  const apps = loadApps(), R = routingFor(j);
  let id;
  do { id = `${j.prefix}-` + crypto.randomInt(0, 1e6).toString().padStart(6, "0"); } while (apps[id]);
  const [department, next_steps] = R[input.type] ?? R.other;
  apps[id] = { ...input, jur: j.id, jurisdiction: j.name, confirmation_number: id, status: "received", department, next_steps, submitted_at: new Date().toISOString() };
  saveApps(apps);
  return apps[id];
}
// Cited video moments, cached so a resident can come back to the exact clip later.
const CLIPS_FILE = "./data/clips.json";
function loadClips() { try { return JSON.parse(fs.readFileSync(CLIPS_FILE, "utf8")); } catch { return {}; } }
export function saveClipsFor(text) {
  const clips = loadClips(); const found = [];
  for (const { videoId, t } of citedMoments(text)) {
    const c = clipWindow(videoId, t); if (!c) continue;
    clips[c.id] = { ...c, cited_at: new Date().toISOString() }; found.push(c);
  }
  if (found.length) fs.writeFileSync(CLIPS_FILE, JSON.stringify(clips, null, 1));
  return found;
}
export function checkStatus(id) { return loadApps()[id.trim().toUpperCase()] ?? { error: "No application found with that confirmation number." }; }

// Every tool runs for the session's active jurisdiction (ctx.jur = registry id or null); set_jurisdiction changes it.
const councilStatus = (jur) => { const c = councilOf(jur); return c.ready ? `indexed ${c.ingested.length} meetings' agendas/minutes (${c.ingested.at(-1)?.date} to ${c.ingested[0]?.date}) and ${c.transcripts} transcripts` : `no council records indexed for ${jurById(jur)?.short ?? "this jurisdiction"} yet; use web_search on its site`; };
const jurContext = (jur, via = "") => contextFor(jurById(jur), { catalogSummary: rag.catalogSummary(jur), councilStatus: councilStatus(jur), via });
const runTool = {
  set_jurisdiction: async ({ jurisdiction }, ctx) => {
    const id = jurById(jurisdiction)?.id ?? detect(jurisdiction) ?? jurById(jurisdiction.toLowerCase().replace(/^(city|county) of /, "").replace(/\s+county$/, "-county").replace(/\s+/g, "-"))?.id;
    if (!id || jurById(id).context) throw new Error(`"${jurisdiction}" is not a covered city or county. Covered: Santa Monica, every city in San Diego and Orange counties, and the County of San Diego / County of Orange.`);
    ctx.setJur(id); return jurContext(id);
  },
  search_city_knowledge: async ({ query }, ctx) => JSON.stringify(rag.search(query, 6, ctx.jur)),
  query_dataset: async (input, ctx) => JSON.stringify(await queryDataset({ ...input, portal: rag.datasetFor(input.resource_id)?.portal ?? input.portal })),
  search_council_meetings: async ({ query, year, doc }, ctx) => JSON.stringify({
    status: councilStatus(ctx.jur ?? "santa-monica"),
    upcoming: councilOf(ctx.jur ?? "santa-monica").upcoming.map((m) => ({ date: m.date, time: m.time, agenda: m.agenda_url })),
    excerpts: rag.searchCouncil(query, 8, year, doc, ctx.jur),
  }),
  search_local_news: async ({ query, days }, ctx) => JSON.stringify({ status: `${news.total} items from ${news.feeds} feeds, refreshed every 30 min`, articles: rag.searchNews(query, 10, days, ctx.jur) }),
  query_gis: async (input, ctx) => JSON.stringify(await queryGis({ ...input, jur: ctx.jur ?? "santa-monica", point: input.address ? null : ctx.geo })),
  get_live_data: async ({ kind, query }, ctx) => JSON.stringify(await liveData(kind, query, ctx.jur ?? "santa-monica", ctx.geo)),
  submit_application: async (input, ctx) => JSON.stringify(submitApplication(input, ctx.J)),
  open_application_form: async ({ type }, ctx) => {
    if (!formsFor(ctx.J.id).includes(type)) throw new Error(`No guided ${type} form for ${ctx.J.name}; collect the details in conversation and file with submit_application.`);
    return JSON.stringify({ shown: true, form: FORMS[type].title, collects: FORMS[type].fields.map((f) => f.label), source: FORMS[type].source, note: "The resident fills this card in and it files the application. Do not ask for these fields." });
  },
  show_contact: async (c) => JSON.stringify({ shown: true, note: "Contact card rendered below your reply. Don't repeat the phone number, email or address in the text; say who to contact and why in one line." }),
  check_application_status: async ({ confirmation_number }) => JSON.stringify(checkStatus(confirmation_number)),
  create_alert: async (input, ctx) => JSON.stringify(await createAlert(rag, { ...input, jur: ctx.J.id })),
  cancel_alert: async ({ confirmation_number }) => JSON.stringify(cancelAlert(confirmation_number)),
};
const STATUS = {
  search_city_knowledge: (i) => `Searching city knowledge: ${i.query}`,
  set_jurisdiction: (i) => `Switching to ${jurById(i.jurisdiction)?.name ?? i.jurisdiction}…`,
  query_dataset: () => "Querying open data…",
  search_council_meetings: (i) => `Searching council agendas & minutes: ${i.query}`,
  search_local_news: (i) => `Searching local news: ${i.query}`,
  query_gis: (i) => i.address ? `Looking up the map at ${i.address}…` : "Querying city GIS…",
  get_live_data: (i) => ({ weather: "Checking the forecast…", tides: "Checking tides…", earthquakes: "Checking USGS…", air_quality: "Checking air quality…", beach_water_quality: "Checking beach grades…", scooters: "Finding scooters…", bus_alerts: "Checking transit alerts…", flights_over_airport: "Checking aircraft near the airport…", traffic_cameras: "Checking traffic cameras…", health_stats: "Pulling CDC health data…", unemployment: "Pulling BLS labor data…", wikipedia: `Reading Wikipedia: ${i.query}`, property: `Looking up assessor record: ${i.query}`, ca_open_data: "Searching California open data…", census: "Pulling Census data…" })[i.kind] ?? "Fetching live data…",
  submit_application: () => "Filing application…",
  open_application_form: (i) => `Opening ${FORMS[i.type]?.title ?? "application"} form…`,
  show_contact: (i) => `Adding contact: ${i.name}`,
  check_application_status: () => "Looking up application…",
  create_alert: (i) => `Setting up daily watch: ${i.topic}`,
  cancel_alert: () => "Cancelling watch…",
};

// Sources shown to the resident: only knowledge chunks that scored close to the best hit and carry their own city URL.
// Datasets are reported separately, only when query_dataset actually reads them.
// ponytail: BM25 heuristics - within 75% of the top score, max 3, and just the top hit when even it matched weakly (flat low scores
// mean the query shares only generic words with the corpus). Revisit if residents see thin or off-topic citations.
const SOURCE_MIN_RATIO = 0.75, WEAK_TOP = 8;
export function pertinentSources(hits, k = 3) {
  const top = hits[0]?.score ?? 0;
  const ok = hits.filter((d) => d.kind === "knowledge" && d.url && d.score >= top * SOURCE_MIN_RATIO);
  return [...new Map(ok.map((d) => [d.url, { kind: "knowledge", title: d.title, url: d.url }])).values()].slice(0, top < WEAK_TOP ? 1 : k);
}

// ponytail: in-memory sessions; lost on restart, fine for a single-process demo.
const sessions = new Map();
const locks = new Map(); // serialize requests per session so concurrent sends can't interleave history
function withSessionLock(sessionId, fn) {
  const prev = locks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(sessionId, next.catch(() => {}));
  return next;
}

// Voice mode: the resident hears the reply read aloud, so it has to sound like a person talking, not a page.
const VOICE_RULE = `Voice mode (only when the resident's message starts with "[voice]"): the resident is speaking to you and will hear your reply read aloud. Answer in one or two short spoken sentences, the way a person answers a question out loud. Lead with the single most useful fact, then at most a short offer of the next step. No lists, bullet points, markdown, headers, links, URLs, phone numbers spelled as digits with dashes, or citations in the text; say "the city's website" rather than reading an address. Still look things up with your tools first; just say the answer briefly. Never mention sources, datasets, documents, records, minutes, transcripts, searches, or where the information came from, and never say "according to" or "the data shows" - state the answer as plain fact.`;

const DEFAULT_JUR = process.env.DEFAULT_JUR || null; // set e.g. santa-monica for a single-city deployment; unset = detect from the conversation
const jurPayload = (j) => j ? { id: j.id, name: j.name, short: j.short, kind: j.kind, icon: j.icon, contact: j.contact?.line ?? "", phone: j.contact?.phone ?? "", site: j.site } : null;
const sessionFor = (id) => { if (!sessions.has(id)) sessions.set(id, { messages: [], jur: DEFAULT_JUR }); return sessions.get(id); };
async function chat(sessionId, userText, send, voice = false, geo = null, jur = null) {
  const session = sessionFor(sessionId), { messages } = session;
  const jurEvent = () => send({ type: "jurisdiction", data: jurPayload(jurById(session.jur)) });
  const setJur = (id, via = "message") => { if (id !== session.jur && jurById(id)) { session.jur = id; session.via = via; jurEvent(); } };
  const hit = detect(userText); if (hit) setJur(hit); // server-side alias/ZIP match; the model's set_jurisdiction covers the rest
  if (geo) session.geo = geo; // latest device location; tools use it whenever the resident hasn't given an address
  if (!session.jur && jur && jurById(jur)) setJur(jur, "location"); // the browser already located itself via /api/locate (remembered across visits)
  if (!session.jur && geo) { const near = nearest(geo.lon, geo.lat); if (near) setJur(near.id, "location"); } // device location, only when nothing was named
  // Preserved thinking: a thinking block's signature is bound to the exact system prompt + tools + earlier messages it was produced
  // under. Anything that varies per request (voice on/off, the date) must not live in `system`, or the next turn 400s. So the voice
  // rule is always in the system prompt and the turn is tagged instead; the date is fixed per session. A jurisdiction switch is a real
  // prefix change - `drop_block` below makes the API drop the stale blocks instead of failing the request.
  messages.push({ role: "user", content: voice ? `[voice] ${userText}` : userText });
  session.today ??= new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });

  for (;;) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"],
      fallbacks: "default",
      output_config: { effort: process.env.EFFORT || "medium" },
      thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } }, // summaries stream to the client; stale blocks are dropped, not fatal
      system: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: jurContext(session.jur, session.via), cache_control: { type: "ephemeral" } }, // identical for every session on the same jurisdiction → cached across users
        { type: "text", text: `Today is ${session.today} (Pacific time).\n\n${VOICE_RULE}` }, // after the cache breakpoint; constant for the life of the session
      ],
      tools: toolsFor(jurById(session.jur)),
      messages,
    }, { maxRetries: 0, timeout: 120000 }); // no silent retry sleeps: a 429/529 surfaces to the user in <1s instead of a 2-minute "Thinking…"
    stream.on("text", (delta) => send({ type: "text", text: delta }));
    stream.on("streamEvent", (ev) => { if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta" && ev.delta.thinking) send({ type: "thinking", text: ev.delta.thinking }); });
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && (block.input?.query || block.input?.url)) send({ type: "status", text: block.name === "web_fetch" ? `Reading ${block.input.url}` : `Searching the web: ${block.input.query}` });
      if (block.type === "tool_use") send({ type: "status", text: STATUS[block.name]?.(block.input) ?? "Working…" });
    });
    const message = await stream.finalMessage();
    messages.push({ role: "assistant", content: message.content });
    // text emitted before a tool call is scratch ("search for it"), not the answer: tell the client to drop it
    if (message.stop_reason === "tool_use" && message.content.some((b) => b.type === "text")) send({ type: "reset" });

    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason === "refusal") { send({ type: "text", text: "\n\nI can't help with that request. For city services, call 311." }); return; }
    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
      // pages the model actually cited from web_search go to the Sources pill, not the text
      const web = [
        ...message.content.flatMap((b) => b.citations ?? []).filter((c) => c.type === "web_search_result_location" && c.url),
        ...messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "web_fetch_tool_result" && b.content?.url).map((b) => ({ url: b.content.url, title: b.content.content?.title })),
      ];
      if (web.length) send({ type: "sources", data: [...new Map(web.map((c) => [c.url, { kind: "web", title: c.title || c.url, url: c.url }])).values()] });
      const clips = saveClipsFor(message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
      if (clips.length) send({ type: "clips", data: clips });
      return;
    }

    const ctx = { get jur() { return session.jur; }, get J() { return jurById(session.jur) ?? SM; }, get geo() { return session.geo ?? null; }, setJur: (id) => setJur(id, "tool") };
    const results = await Promise.all(toolUses.map(async (t) => {
      try {
        const out = await runTool[t.name](t.input, ctx);
        if (t.name === "submit_application") send({ type: "application", data: JSON.parse(out) });
        if (t.name === "create_alert") { const { seen, ...a } = JSON.parse(out); send({ type: "alert", data: a }); }
        if (t.name === "open_application_form") send({ type: "form", data: { type: t.input.type, ...formFor(t.input.type, ctx.J) } }); // the active city's variant of the card
        if (t.name === "show_contact") send({ type: "contact", data: t.input });
        if (t.name === "search_city_knowledge") send({ type: "sources", data: pertinentSources(JSON.parse(out)) });
        if (t.name === "query_dataset") { const ds = rag.datasetFor(t.input.resource_id); if (ds) send({ type: "sources", data: [ds] }); }
        if (t.name === "search_council_meetings") send({ type: "sources", data: [...new Map(JSON.parse(out).excerpts.map((d) => [d.url, { kind: "council", title: d.title, url: d.url }])).values()] });
        if (t.name === "search_local_news") send({ type: "sources", data: JSON.parse(out).articles.slice(0, 5).map((a) => ({ kind: "news", title: `${a.publisher} · ${a.date}: ${a.title}`, url: a.url, publisher: a.publisher })) });
        if (t.name === "query_gis") { const o = JSON.parse(out); send({ type: "sources", data: [{ kind: "gis", title: `${o.layer} (GIS layer)`, url: t.input.service_url }] }); }
        if (t.name === "get_live_data") { const o = JSON.parse(out); if (o.url) send({ type: "sources", data: [{ kind: "live", title: o.source, url: o.url }] }); }
        return { type: "tool_result", tool_use_id: t.id, content: out };
      } catch (e) {
        return { type: "tool_result", tool_use_id: t.id, is_error: true, content: String(e.message) };
      }
    }));
    messages.push({ role: "user", content: results });
  }
}

// ponytail: distinct SitusStreet values by prefix, cached per prefix for the process lifetime (street names don't change)
const streetCache = new Map();
async function streetNames(prefix) {
  if (streetCache.has(prefix)) return streetCache.get(prefix);
  const url = "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query?" + new URLSearchParams({
    where: `SitusCity LIKE 'SANTA MONICA%' AND UPPER(SitusStreet) LIKE '${prefix.replace(/'/g, "''")}%'`, outFields: "SitusStreet", returnDistinctValues: "true", returnGeometry: "false", orderByFields: "SitusStreet", resultRecordCount: "25", f: "json" });
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); const j = await r.json(); if (j.error) throw new Error(j.error.message);
  const ABBR = { STREET: "St", AVENUE: "Ave", BOULEVARD: "Blvd", DRIVE: "Dr", PLACE: "Pl", COURT: "Ct", LANE: "Ln", ROAD: "Rd", WAY: "Way", TERRACE: "Ter", CIRCLE: "Cir", HIGHWAY: "Hwy", PARKWAY: "Pkwy", ST: "St", AVE: "Ave", BLVD: "Blvd", DR: "Dr", PL: "Pl", CT: "Ct", LN: "Ln", RD: "Rd", TER: "Ter", CIR: "Cir", HWY: "Hwy", PKWY: "Pkwy" };
  const title = (w) => ABBR[w] ?? (/^\d/.test(w) ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase());
  const names = [...new Set(j.features.map((f) => f.attributes.SitusStreet.trim().split(/\s+/).map(title).join(" ")))]; // "EUCLID ST" + "EUCLID STREET" → one "Euclid St"
  streetCache.set(prefix, names);
  return names;
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let sessionId, message, voice, geo, jur;
    try {
      ({ sessionId, message, voice, geo, jur } = JSON.parse(body));
      geo = geo && Number.isFinite(+geo.lat) && Number.isFinite(+geo.lon) && +geo.lat > 32 && +geo.lat < 42.1 && +geo.lon > -124.6 && +geo.lon < -114 ? { lat: +geo.lat, lon: +geo.lon } : null; // California only; anything else is ignored
      if (typeof message !== "string" || !message.trim() || message.length > 8000) throw new Error("bad message");
      if (typeof sessionId !== "string" || !/^[\w-]{1,64}$/.test(sessionId)) throw new Error("bad session");
    } catch { res.writeHead(400).end("bad request"); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    try {
      await withSessionLock(sessionId, () => chat(sessionId, message.trim(), send, voice === true, geo, typeof jur === "string" ? jur : null));
    } catch (e) {
      const msg = e instanceof Anthropic.AuthenticationError ? "Server is missing a valid ANTHROPIC_API_KEY (see .env.example)."
        : e instanceof Anthropic.RateLimitError ? "Rate limited, try again in a moment."
        : e instanceof Anthropic.APIError ? `API error ${e.status}: ${e.message}` : e.message;
      console.error(e);
      send({ type: "error", text: msg });
      // roll history back to before this turn's user message so it stays valid
      const h = sessions.get(sessionId)?.messages ?? [];
      const i = h.findLastIndex((m) => m.role === "user" && typeof m.content === "string");
      if (i >= 0) h.splice(i);
    }
    send({ type: "done" });
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === "/api/locate") { // device coordinates → nearest covered city/county, so the page knows where it is before the first message
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { geo } = JSON.parse(body); const lat = Number(geo?.lat), lon = Number(geo?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw 0;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(jurPayload(nearest(lon, lat))));
    } catch { res.writeHead(400).end("bad request"); }
    return;
  }
  if (req.method === "POST" && req.url === "/api/applications") { // filed from a form card
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { sessionId, type, fields } = JSON.parse(body);
      const sess = typeof sessionId === "string" ? sessions.get(sessionId) : null;
      const J = jurById(sess?.jur) ?? SM; // validate against, and file with, the city the resident was talking to
      const app = submitApplication(toApplication(type, fields, J), J);
      // Let the assistant know so follow-up questions in the same chat have the confirmation number.
      const h = sess?.messages;
      if (h && h.at(-1)?.role === "assistant") h.push({ role: "user", content: `[Form submitted] ${app.summary} - confirmation ${app.confirmation_number}.\n${app.details}` }, { role: "assistant", content: `Application ${app.confirmation_number} received and routed to ${app.department}.` });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(app));
    } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (req.method === "POST" && req.url === "/tts") { // local Kokoro voice for voice mode; 404 when TTS=off so the client falls back to the browser voice
    if (process.env.TTS === "off") { res.writeHead(404).end(); return; }
    let text = "";
    try { let b = ""; for await (const c of req) b += c; ({ text } = JSON.parse(b)); if (typeof text !== "string" || !text.trim()) throw 0; } catch { res.writeHead(400).end("bad request"); return; }
    try { res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" }).end(await speakWav(text)); }
    catch (e) { console.error("tts:", e.message); if (!res.headersSent) res.writeHead(502).end(); else res.end(); }
    return;
  }
  if (req.method === "POST" && req.url === "/api/feedback") { // thumbs up/down on an answer → data/feedback.jsonl
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { sessionId, vote, answer } = JSON.parse(body);
      if (![null, "up", "down"].includes(vote) || typeof answer !== "string") throw new Error("bad feedback");
      fs.mkdirSync("./data", { recursive: true });
      fs.appendFileSync("./data/feedback.jsonl", JSON.stringify({ at: new Date().toISOString(), sessionId: String(sessionId).slice(0, 64), vote, answer: answer.slice(0, 4000) }) + "\n");
      res.writeHead(204).end();
    } catch { res.writeHead(400).end("bad request"); }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/addresses?")) { // autocomplete against the city's official address points
    const u = new URL(req.url, "http://x"), q = (u.searchParams.get("q") ?? "").slice(0, 80);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(suggestAddresses(q, 8, u.searchParams.get("jur"))));
    return;
  }
  if (req.method === "GET" && req.url === "/api/clips") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Object.values(loadClips()).sort((a, b) => b.cited_at.localeCompare(a.cited_at))));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/clips/")) {
    const c = loadClips()[decodeURIComponent(req.url.slice(11))];
    res.writeHead(c ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(c ?? { error: "clip not found" }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/alerts") { // "Watch a topic" form in the Menu
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { topic, address = "", email, name = "" } = JSON.parse(body);
      if (typeof topic !== "string" || topic.trim().length < 3 || topic.length > 300) throw new Error("Describe what to watch in a few words.");
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email for the alerts.");
      const { seen, ...a } = await createAlert(rag, { topic: topic.trim(), address: String(address).trim().slice(0, 200), email: email.trim(), name: String(name).trim().slice(0, 100) });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(a));
    } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/alerts/")) { // "Stop watching" in the Menu
    const r = cancelAlert(decodeURIComponent(req.url.slice(12)));
    res.writeHead(r.error ? 404 : 200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
    return;
  }
  if (req.method === "POST" && req.url === "/api/alerts/run") { // run the daily watch now (demo / external cron hook)
    try { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await runAlerts(rag))); }
    catch (e) { res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (req.method === "GET" && req.url === "/dev") { // live reload: page reloads when public/ changes or the server restarts (npm run dev)
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }).write(": ok\n\n");
    const w = fs.watch("public", { recursive: true }, () => res.write("data: reload\n\n"));
    req.on("close", () => w.close());
    return;
  }
  const json = (code, o) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(o));
  // Resident self-service: edit an application they filed. Ownership = the email on the record; only while staff haven't picked it up.
  if (req.method === "PATCH" && req.url.startsWith("/api/applications/")) {
    let body = ""; for await (const chunk of req) body += chunk;
    let patch; try { patch = JSON.parse(body); } catch { return json(400, { error: "bad request" }); }
    const apps = loadApps(), app = apps[decodeURIComponent(req.url.slice(18)).trim().toUpperCase()];
    if (!app) return json(404, { error: "No application found with that confirmation number." });
    if (String(patch.email ?? "").trim().toLowerCase() !== String(app.email ?? "").toLowerCase()) return json(403, { error: "Email does not match this application." });
    if (app.status !== "received") return json(409, { error: `This application is already ${app.status.replace("_", " ")} and can no longer be edited. Contact ${app.department}.` });
    for (const k of ["applicant_name", "phone", "address", "requested_date", "details"]) if (typeof patch[k] === "string") app[k] = patch[k].trim().slice(0, 4000);
    app.updated_at = new Date().toISOString(); saveApps(apps);
    return json(200, app);
  }
  // Staff desk (/staff): a department's queue, search by applicant name, set status + note. No AI here.
  if (req.url.startsWith("/api/staff/")) {
    if (req.headers["x-staff-code"] !== STAFF_CODE) return json(401, { error: "Staff code required." });
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/api/staff/departments") { // grouped: county → cities (county government first) → departments
      const groups = new Map();
      for (const j of SERVED) {
        const departments = [...new Set(Object.values(routingFor(j)).map(([d]) => d))].sort();
        if (!departments.length) continue;
        const c = j.kind === "county" ? j : countyOf(j), key = c?.id ?? j.id;
        if (!groups.has(key)) groups.set(key, { county: c?.short ?? j.short, cities: [] });
        groups.get(key).cities.push({ city: j.short, isCounty: j.kind === "county", departments });
      }
      for (const g of groups.values()) g.cities.sort((a, b) => (b.isCounty - a.isCounty) || a.city.localeCompare(b.city));
      return json(200, [...groups.values()].sort((a, b) => a.county.localeCompare(b.county)));
    }
    if (req.method === "GET" && u.pathname === "/api/staff/applications") {
      const dept = u.searchParams.get("department") || "all", q = (u.searchParams.get("q") || "").trim().toLowerCase();
      const list = Object.values(loadApps())
        .filter((a) => a.type && (dept === "all" || a.department === dept) && (!q || [a.applicant_name, a.email, a.confirmation_number, a.summary].join(" ").toLowerCase().includes(q)))
        .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
      return json(200, list);
    }
    if (req.method === "PATCH" && u.pathname.startsWith("/api/staff/applications/")) {
      let body = ""; for await (const chunk of req) body += chunk;
      let patch; try { patch = JSON.parse(body); } catch { return json(400, { error: "bad request" }); }
      const apps = loadApps(), app = apps[decodeURIComponent(u.pathname.slice(24)).trim().toUpperCase()];
      if (!app) return json(404, { error: "not found" });
      if (patch.status != null && !STATUSES.includes(patch.status)) return json(400, { error: `status must be one of ${STATUSES.join(", ")}` });
      if (patch.status) app.status = patch.status;
      if (typeof patch.note === "string") app.staff_note = patch.note.trim().slice(0, 2000);
      if (typeof patch.reviewer === "string" && patch.reviewer.trim()) app.reviewed_by = patch.reviewer.trim().slice(0, 120);
      app.updated_at = new Date().toISOString(); saveApps(apps);
      return json(200, app);
    }
    return json(404, { error: "not found" });
  }
  if (req.method === "GET" && req.url.startsWith("/api/streets?")) { // address autocomplete: Santa Monica street names from the LA County Assessor roll
    const q = (new URL(req.url, "http://x").searchParams.get("q") ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim().slice(0, 40);
    if (q.length < 2) { res.writeHead(200, { "Content-Type": "application/json" }).end("[]"); return; }
    try { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }).end(JSON.stringify(await streetNames(q))); }
    catch (e) { res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/applications/")) {
    const r = checkStatus(decodeURIComponent(req.url.slice(18)));
    res.writeHead(r.error ? 404 : 200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
    return;
  }
  const pub = path.resolve("public");
  const file = path.resolve(pub, "." + (req.url === "/" ? "/index.html" : req.url === "/staff" ? "/staff.html" : req.url.split("?")[0]));
  if (!file.startsWith(pub + path.sep)) return res.writeHead(404).end("not found");
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" }).end(data);
  });
});
// Only bind the port when run directly; test.js and ad-hoc scripts import this module and must not take over :8787.
if (import.meta.main) server.listen(PORT, () => console.log(`GovAI (${SERVED.length} jurisdictions) → http://localhost:${PORT}`));
