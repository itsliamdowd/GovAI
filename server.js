import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { buildIndex, queryDataset } from "./rag.js";
import { ingestCouncil } from "./council.js";
import { ingestTranscripts, clipWindow, citedMoments } from "./transcripts.js";
import { createAlert, cancelAlert, runAlerts } from "./alerts.js";
import { FORMS, FORM_TYPES, toApplication } from "./forms.js";
import { ingestNews, loadNewsDocs, loadGisCatalog, gisDocs, queryGis, liveData, LIVE_KINDS, LIVE_HELP } from "./sources.js";

const PORT = Number(process.env.PORT) || 8787;
const APPS_FILE = "./data/applications.json";
try { process.loadEnvFile(); } catch {} // load .env ourselves so `node server.js`, warm.js, one-off scripts and tests all work without --env-file
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("Missing ANTHROPIC_API_KEY. Add a line ANTHROPIC_API_KEY=sk-ant-... to the .env file in the project root (no quotes, no spaces around =), then restart npm run dev.");
  process.exit(1);
}
const client = new Anthropic();
// Default is Sonnet: the "Hackathon" workspace caps claude-opus-5-5 at 1 input token/min, so Opus 429s on every call.
// Raise that limit in console.anthropic.com → Settings → Limits, then set MODEL=claude-opus-5-5 in .env.
const MODEL = process.env.MODEL || "claude-sonnet-5-5";

const rag = await buildIndex();
console.log(`RAG index ready: ${rag.datasetCount} open datasets indexed`);
let council = { ready: false, ingested: [], upcoming: [], transcripts: 0 };
function refreshCouncil() {
  return Promise.all([
    ingestCouncil((docs, meta) => { rag.addDocs(docs); council = { ...council, ready: true, ...meta }; console.log(`Council: ${meta.ingested.length} meetings (agendas+minutes), ${docs.length} chunks indexed`); })
      .catch((e) => console.error("council ingestion failed:", e.message)),
    ingestTranscripts((docs, videos) => { rag.addDocs(docs); council.transcripts = videos.filter((v) => docs.some((d) => d.url.includes(v.id))).length; console.log(`Transcripts: ${council.transcripts} meetings, ${docs.length} chunks indexed`); })
      .catch((e) => console.error("transcript ingestion failed (is yt-dlp installed?):", e.message)),
  ]);
}
refreshCouncil();
// Daily watch: re-pull council records, then diff + judge + email each alert. ALERT_HOUR local, default 07:00.
const runWatch = () => refreshCouncil().then(() => runAlerts(rag)).catch((e) => console.error("alert run failed:", e.message));
function scheduleDaily(fn) {
  const now = new Date(), next = new Date(now); next.setHours(Number(process.env.ALERT_HOUR ?? 7), 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { fn(); setInterval(fn, 864e5).unref(); }, next - now).unref();
  console.log(`Daily watch scheduled for ${next.toLocaleString()}`);
}
scheduleDaily(runWatch);
// City + county GIS layers become searchable "gis" docs; local news is pulled now and every 30 minutes.
let gisCount = 0;
loadGisCatalog().then((layers) => { rag.addDocs(gisDocs(layers)); gisCount = layers.length; console.log(`GIS: ${gisCount} city/county layers indexed`); }).catch((e) => console.error("gis catalog failed:", e.message));
let news = { total: 0, feeds: 0 };
rag.addDocs(loadNewsDocs()); // index the cached articles now; ingestNews only emits items that are new since the last run, so without this the news index is empty after every restart until a feed yields something new
const refreshNews = () => ingestNews((docs, meta) => { rag.addDocs(docs); news = meta; console.log(`News: ${meta.fresh} new, ${meta.total} total items from ${meta.feeds} feeds`); }).catch((e) => console.error("news ingestion failed:", e.message));
refreshNews(); setInterval(refreshNews, 30 * 60e3).unref();

const SYSTEM = `You are the City of Santa Monica's digital assistant: one front door to every city service, like america.gov but for a city.

What you do
- Answer anything about Santa Monica city government, services, permits, fees, rules, departments, parks, transit, trash, parking, housing, council, open data, and how to get things done.
- Take permit and service applications. Guided forms exist for: ${FORM_TYPES.join(", ")}. When a resident wants to apply for, request, or report one of these (including "how do I get a block party permit", a pothole, a missed pickup): call search_city_knowledge, then call open_application_form with the type, then END YOUR TURN WITH NO TEXT. The card is the whole reply: it shows the fee, deadline, what they need and the official page, and collects the details. Anything you write after opening a card is not displayed. Never ask in chat for the fields the form collects (name, email, phone, address, dates, etc.) and never call submit_application for a form type; the card submits it and you will see the confirmation number in the conversation afterwards.
- For types with no form (film_permit, encroachment_permit, temporary_use_permit, sidewalk_vending_permit, home_share_license, alarm_permit, other): collect only the required fields through a natural conversation (one or two questions at a time), confirm a summary, then call submit_application and end your turn with no text: the confirmation card shows the number, the department and next steps, and any text after it is not displayed.
- Look up application status with check_application_status when given a confirmation number.
- Set up a daily watch when a resident wants to be told if something changes: "track 1685 Main St", "let me know if council talks about the pier", "alert me when my block's parking rules change". Ask for their email (and the address if the topic is a place), restate what will be watched and explain it BEFORE calling: it's checked every morning against council agendas/minutes/transcripts and the city's open data, and they only get an email when something new actually concerns their topic. Then call create_alert and end your turn with no text; the watch card confirms it and any text after it is not displayed. cancel_alert stops it (number format WATCH-XXXXXX).

How you find answers (retrieval first, always)
1. Call search_city_knowledge with the resident's question before answering anything factual. It returns the most relevant city knowledge chunks AND matching open datasets (with resource_ids and field names).
2. If a dataset can answer (fees, active permits, business licenses, police/fire calls, rents, parking rates, trees, EV chargers, budget, campaign finance, water, etc.), call query_dataset with the resource_id and a full-text q or filters, then answer from the rows.
3. For anything about City Council: what was decided, who voted how, what's on an agenda, what a councilmember or speaker actually said, upcoming meetings — call search_council_meetings. It searches agendas, official minutes (the record of the meeting, back to 2015) and meeting transcripts (YouTube captions, July 2014 onward where a recording exists) and returns dated excerpts with links. Use doc="minutes" for votes/decisions, doc="transcript" for quotes/what was said, empty for both. Quote dates; cite the minutes link or the timestamped video link. When you quote or paraphrase something said in a meeting, include the transcript excerpt's exact url (the youtube link with &t=) as a markdown link — the app turns it into a playable clip of that moment. Transcripts are auto-captions and may misspell names.
4. For what's happening in town — news, controversies, crime, closures, openings, elections, school district, SMC, what residents are saying — call search_local_news. It searches the Santa Monica Daily Press, Santa Monica Mirror, Santa Monica Next, Santa Monica Observer, Santa Monica Lookout, Westside Current, Patch, LA Times, KCRW, LAist, city news releases, CityTV meeting videos and r/SantaMonica, refreshed every 30 minutes. Give the date and the publisher in the text ("the Daily Press reported on Oct 12 that…"); reporting is not city policy, say which it is.
5. For anything about a specific place or address — zoning, land use, preferential parking zone and rules, street sweeping day, bike lanes, nearby trees, historic status, fault/liquefaction/tsunami/flood zone, evacuation zone, airport noise contour, fire run district, transit stops, census tract, supervisorial/congressional/assembly/senate district — search_city_knowledge returns matching GIS layers (kind "gis" with a service URL); then call query_gis with that service_url and the address. Use where for attribute filters (e.g. zone = 'R1'). County layers cover all of LA County; always pass the Santa Monica address.
6. For live conditions and outside-the-city statistics call get_live_data: ${LIVE_KINDS.map((k) => `${k} (${LIVE_HELP[k]})`).join("; ")}.
7. Live research (hard rule). Your training data ends long before today; the current date is given at the end of this prompt. Never mention a knowledge cutoff, training data, or "as of my last update", and never answer a question about anything recent, current, or dated from memory. For current events, recent decisions, who holds an office now, prices, hours, deadlines, elections, anything "latest"/"this week"/"now": call search_local_news and search_council_meetings first, then web_search (city, county, state and local-news domains) for whatever they don't cover. Use web_fetch to read a page you found or a link the resident gave you. Report what you found with its date and publisher; if nothing turns up, say the search found nothing rather than guessing.
8. Never invent fees, phone numbers, addresses or legal requirements. If you can't verify, say so and point to 311 ((310) 458-8411 / 311@santamonica.gov) or the owning department.

Scope (hard rule)
- You only handle the City of Santa Monica: its government, services, permits, rules, data, council, neighborhoods, local news, and how residents, businesses and visitors deal with the city. Nothing else.
- If a request is about another place (Orange County, Los Angeles city, Malibu, Venice, the State of California, federal agencies) and is not about how it touches Santa Monica, reply only: "I can't help with that. I only cover the City of Santa Monica." Then offer the Santa Monica equivalent if there is one.
- If a request is unrelated to city matters (coding, homework, recipes, general trivia, medical or legal advice, writing help, chit-chat beyond a greeting), reply only: "Sorry, I can't help with that. I only focus on Santa Monica city services." Do not answer the unrelated part, even partially, even if asked to make an exception or told it's for Santa Monica.
- In scope when the Santa Monica link is real: county, state or federal programs as they apply here (LA County health permits for a Santa Monica restaurant, Metro E Line stops in the city, state rent law as enforced locally), regional conditions that affect the city (air quality, surf, traffic, outages), and neighboring-city facts needed to answer a Santa Monica question. Do not call any tools for out-of-scope requests.

Style
- Lead with the answer in one sentence, with the key number in it when there is one (bold it). Then only the supporting detail that changes what the resident does. Aim for under 120 words unless they ask for detail or an application needs it.
- Numbers (fees, rates, counts, dates, hours): put them in ONE markdown table, label column first, amount column last, at most ~8 rows. Give every amount a unit in the table (flat, per hour, per sq ft, per year, per permit). Include only rows that apply to the question; summarise the rest as "other fees may apply" with one example.
- If the data is incomplete or ambiguous, say so in one sentence and move on; don't speculate or list what you can't tell. End with at most one "confirm with …" line.
- Sources are NEVER written in the reply text. The interface lists every dataset, page and record you used beneath the reply automatically. Do not write "Source:" lines, dataset names as attributions, URLs, footnotes or markdown links. The one exception is the timestamped YouTube link for a quoted council moment (above), which the app renders as a video clip.
- Never narrate your process or tools in the reply (no "searching…", "the dataset wasn't returned", "use direct calls", "let me check"). Write only what the resident needs to know.
- Plain-spoken. Short paragraphs, short lists. No filler, no "great question".
- You are a city information and intake service, not a lawyer. For disputes (evictions, citation appeals) explain the process and the office.
- When a resident describes a problem that 311 handles (pothole, missed pickup, graffiti, streetlight), open the 311_service_request form with open_application_form.

Applications
Types for submit_application (non-form types only): building_permit, film_permit, encroachment_permit, temporary_use_permit, sidewalk_vending_permit, home_share_license, alarm_permit, other. A block party on a public street is block_party_permit (its own simpler process, $100.95), not a community event permit.
Required for every application: applicant_name, email, phone. Collect address (project/event/service location) for everything except business_license (use business address) and dog_license (owner address). Ask for a date when the permit is time-bound (events, film, encroachment, pickups). Put everything else the department would need in details (event: attendance, venue, street closure, alcohol, amplified sound; building: scope, contractor, valuation; film: company, crew size, equipment, locations).

Open datasets available on data.santamonica.gov (search_city_knowledge finds the right one and its fields):
${rag.catalogSummary}`;

const WEB_DOMAINS = [
      "santamonica.gov", "permits.santamonica.gov", "data.santamonica.gov", "filmsantamonica.com", "bigbluebus.com", "smpl.org", "smgov.net", "santamonicapd.org", "santamonicacityca.iqm2.com", "santamonica.granicus.com", "governmentjobs.com",
      "smdp.com", "smmirror.com", "santamonicanext.org", "surfsantamonica.com", "smobserved.com", "westsidecurrent.com", "patch.com", "kcrw.com", "laist.com", "thecorsaironline.com",
      "lacounty.gov", "lavote.gov", "lahsa.org", "assessor.lacounty.gov", "publichealth.lacounty.gov", "metro.net", "ca.gov", "smc.edu", "smmusd.org", "downtownsm.com", "santamonicapier.org", "santamonica.com", "healthebay.org", "en.wikipedia.org",
];
const tools = [
  {
    name: "search_city_knowledge",
    description: "Retrieve the most relevant City of Santa Monica knowledge chunks and open datasets for a question. Call this first for any factual question.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Natural-language question or keywords." } },
      required: ["query"], additionalProperties: false,
    },
  },
  {
    name: "query_dataset",
    description: "Query rows from a data.santamonica.gov dataset resource (CKAN datastore). Use resource_id from search_city_knowledge. q is full-text search across all fields; filters is a JSON object string of exact field matches, e.g. {\"department\":\"Public Works\"}; sort like \"fee desc\".",
    strict: true,
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
    strict: true,
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
    description: "Query a City of Santa Monica or LA County GIS layer (ArcGIS REST). Pass the layer's service_url from a search_city_knowledge 'gis' result. address finds the feature(s) at that Santa Monica address (polygon layers: the containing zone; point/line layers: within 250 m). where is an ArcGIS SQL filter on the layer's fields, or empty. Returns the layer's fields and matching records.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        service_url: { type: "string", description: "e.g. https://gis.santamonica.gov/server/rest/services/Zoning/FeatureServer/2" },
        address: { type: "string", description: "Street address in Santa Monica, or empty string." },
        where: { type: "string", description: "ArcGIS SQL where clause, or empty string." },
        limit: { type: "integer", description: "Max records, 1-100." },
      },
      required: ["service_url", "address", "where", "limit"], additionalProperties: false,
    },
  },
  {
    name: "get_live_data",
    description: `Fetch live or external data about Santa Monica. kind is one of: ${LIVE_KINDS.map((k) => `${k} — ${LIVE_HELP[k]}`).join("; ")}.`,
    strict: true,
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
    description: "Search Santa Monica City Council agendas, official minutes (2015-present) and meeting transcripts (YouTube captions, 2014-present). Returns dated excerpts with links (minutes PDF, agenda page, or timestamped video) plus upcoming meeting dates. Use for votes, decisions, agenda items, public hearings, what council or public speakers said.",
    strict: true,
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
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 5,
    allowed_domains: WEB_DOMAINS,
    user_location: { type: "approximate", city: "Santa Monica", region: "California", country: "US" },
  },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3, allowed_domains: WEB_DOMAINS, citations: { enabled: true }, max_content_tokens: 20000 },
  {
    name: "submit_application",
    description: "File a permit application or service request with the City of Santa Monica. Only call after the applicant has confirmed the summarized details. Returns a confirmation number.",
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
    strict: true,
    input_schema: { type: "object", properties: { confirmation_number: { type: "string" } }, required: ["confirmation_number"], additionalProperties: false },
  },
  {
    name: "open_application_form",
    description: "Show the resident a step-by-step application card for a predefined permit or service request. The card collects the city's required information and files the application itself. Call this instead of asking for applicant details in chat.",
    strict: true,
    input_schema: { type: "object", properties: { type: { type: "string", enum: FORM_TYPES } }, required: ["type"], additionalProperties: false },
  },
  {
    name: "check_application_status",
    description: "Look up a previously filed application by confirmation number (format SM-XXXXXX).",
    strict: true,
    input_schema: { type: "object", properties: { confirmation_number: { type: "string" } }, required: ["confirmation_number"], additionalProperties: false },
  },
];

// ponytail: JSON file store; swap for a DB when more than one server instance exists.
function loadApps() { try { return JSON.parse(fs.readFileSync(APPS_FILE, "utf8")); } catch { return {}; } }
function saveApps(apps) { fs.mkdirSync(path.dirname(APPS_FILE), { recursive: true }); fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2)); }
const ROUTING = {
  building_permit: ["Building & Safety, Permit Services Center", "Plan check assignment within 2 business days; simple trade permits often issue same day."],
  business_license: ["Finance, Business License Office", "Review within 5 business days; you'll receive a tax bill before the license issues."],
  community_event_permit: ["Community Services, Community Events Office", "Staff review within 10 business days; large events may need Police, Fire and Public Works sign-off."],
  block_party_permit: ["Transportation Planning (Mobility Division)", "Departments review the request; once approved you'll be emailed to pay the $100.95 fee and download the permit. Pick up signs and barricades at City Yards, 2500 Michigan Ave, and give neighbors 3–5 days' notice."],
  film_permit: ["Film Santa Monica", "Review within 5 business days; a location fee and insurance certificate will be requested."],
  encroachment_permit: ["Public Works, Engineering", "Review within 5 business days; traffic control plan may be required."],
  preferential_parking_permit: ["Finance, Parking Permits", "Proof of residency verified within 3 business days; permit mailed or available for pickup."],
  temporary_use_permit: ["Planning Division", "Review within 10 business days."],
  sidewalk_vending_permit: ["Finance / Code Enforcement", "Review within 10 business days; county health permit required for food."],
  home_share_license: ["Finance, Business License Office", "Review within 10 business days; host must reside on site."],
  dog_license: ["Santa Monica Animal Shelter (Animal Services)", "Issued within 5 business days once the rabies certificate is verified; the tag is mailed to you."],
  alarm_permit: ["SMPD Alarm Unit", "Issued within 5 business days."],
  bulky_item_pickup: ["Public Works, Resource Recovery & Recycling", "Collection within 7–10 days; set items at the curb the night before."],
  "311_service_request": ["Santa Monica 311", "Routed to the responsible division; most requests acknowledged within 2 business days."],
  other: ["Santa Monica 311", "311 staff will route to the correct department within 2 business days."],
};
export function submitApplication(input) {
  const apps = loadApps();
  let id;
  do { id = "SM-" + crypto.randomInt(0, 1e6).toString().padStart(6, "0"); } while (apps[id]);
  const [department, next_steps] = ROUTING[input.type] ?? ROUTING.other;
  apps[id] = { ...input, confirmation_number: id, status: "received", department, next_steps, submitted_at: new Date().toISOString() };
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

const runTool = {
  search_city_knowledge: async ({ query }) => JSON.stringify(rag.search(query)),
  query_dataset: async (input) => JSON.stringify(await queryDataset(input)),
  search_council_meetings: async ({ query, year, doc }) => JSON.stringify({
    status: council.ready ? `indexed ${council.ingested.length} meetings' agendas/minutes (${council.ingested.at(-1)?.date} to ${council.ingested[0]?.date}) and ${council.transcripts} transcripts` : "council records still loading; try again shortly or use web_search",
    upcoming: council.upcoming.map((m) => ({ date: m.date, time: m.time, agenda: m.agenda_url })),
    excerpts: rag.searchCouncil(query, 8, year, doc),
  }),
  search_local_news: async ({ query, days }) => JSON.stringify({ status: `${news.total} items from ${news.feeds} feeds, refreshed every 30 min`, articles: rag.searchNews(query, 10, days) }),
  query_gis: async (input) => JSON.stringify(await queryGis(input)),
  get_live_data: async ({ kind, query }) => JSON.stringify(await liveData(kind, query)),
  submit_application: async (input) => JSON.stringify(submitApplication(input)),
  open_application_form: async ({ type }) => JSON.stringify({ shown: true, form: FORMS[type].title, collects: FORMS[type].fields.map((f) => f.label), source: FORMS[type].source, note: "The resident fills this card in and it files the application. Do not ask for these fields." }),
  check_application_status: async ({ confirmation_number }) => JSON.stringify(checkStatus(confirmation_number)),
  create_alert: async (input) => JSON.stringify(await createAlert(rag, input)),
  cancel_alert: async ({ confirmation_number }) => JSON.stringify(cancelAlert(confirmation_number)),
};
const STATUS = {
  search_city_knowledge: (i) => `Searching city knowledge: ${i.query}`,
  query_dataset: () => "Querying data.santamonica.gov…",
  search_council_meetings: (i) => `Searching council agendas & minutes: ${i.query}`,
  search_local_news: (i) => `Searching local news: ${i.query}`,
  query_gis: (i) => i.address ? `Looking up the map at ${i.address}…` : "Querying city GIS…",
  get_live_data: (i) => ({ weather: "Checking the forecast…", tides: "Checking tides…", earthquakes: "Checking USGS…", air_quality: "Checking air quality…", beach_water_quality: "Checking beach grades…", scooters: "Finding scooters…", bus_alerts: "Checking Big Blue Bus alerts…", flights_over_airport: "Checking aircraft near SMO…", traffic_cameras: "Checking traffic cameras…", health_stats: "Pulling CDC health data…", unemployment: "Pulling BLS labor data…", wikipedia: `Reading Wikipedia: ${i.query}`, property: `Looking up assessor record: ${i.query}`, ca_open_data: "Searching California open data…", census: "Pulling Census data…" })[i.kind] ?? "Fetching live data…",
  submit_application: () => "Filing application…",
  open_application_form: (i) => `Opening ${FORMS[i.type]?.title ?? "application"} form…`,
  check_application_status: () => "Looking up application…",
  create_alert: (i) => `Setting up daily watch: ${i.topic}`,
  cancel_alert: () => "Cancelling watch…",
};

// Sources shown to the resident: only knowledge chunks that scored close to the best hit and carry their own city URL.
// Datasets are reported separately, only when query_dataset actually reads them.
// ponytail: BM25 heuristics — within 75% of the top score, max 3, and just the top hit when even it matched weakly (flat low scores
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

async function chat(sessionId, userText, send) {
  const messages = sessions.get(sessionId) ?? [];
  sessions.set(sessionId, messages);
  messages.push({ role: "user", content: userText });

  for (;;) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: process.env.EFFORT || "medium" },
      thinking: { type: "adaptive", display: "summarized" }, // summaries stream to the client so the "Thinking…" pause shows what it's doing
      system: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" })} (Pacific time).` }, // after the cache breakpoint so the prefix stays cached
      ],
      tools,
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

    const results = await Promise.all(toolUses.map(async (t) => {
      try {
        const out = await runTool[t.name](t.input);
        if (t.name === "submit_application") send({ type: "application", data: JSON.parse(out) });
        if (t.name === "create_alert") { const { seen, ...a } = JSON.parse(out); send({ type: "alert", data: a }); }
        if (t.name === "open_application_form") send({ type: "form", data: { type: t.input.type, ...FORMS[t.input.type] } });
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

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let sessionId, message;
    try {
      ({ sessionId, message } = JSON.parse(body));
      if (typeof message !== "string" || !message.trim() || message.length > 8000) throw new Error("bad message");
      if (typeof sessionId !== "string" || !/^[\w-]{1,64}$/.test(sessionId)) throw new Error("bad session");
    } catch { res.writeHead(400).end("bad request"); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    try {
      await withSessionLock(sessionId, () => chat(sessionId, message.trim(), send));
    } catch (e) {
      const msg = e instanceof Anthropic.AuthenticationError ? "Server is missing a valid ANTHROPIC_API_KEY (see .env.example)."
        : e instanceof Anthropic.RateLimitError ? "Rate limited, try again in a moment."
        : e instanceof Anthropic.APIError ? `API error ${e.status}: ${e.message}` : e.message;
      console.error(e);
      send({ type: "error", text: msg });
      // roll history back to before this turn's user message so it stays valid
      const h = sessions.get(sessionId) ?? [];
      const i = h.findLastIndex((m) => m.role === "user" && typeof m.content === "string");
      if (i >= 0) h.splice(i);
    }
    send({ type: "done" });
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === "/api/applications") { // filed from a form card
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { sessionId, type, fields } = JSON.parse(body);
      const app = submitApplication(toApplication(type, fields));
      // Let the assistant know so follow-up questions in the same chat have the confirmation number.
      const h = typeof sessionId === "string" && sessions.get(sessionId);
      if (h && h.at(-1)?.role === "assistant") h.push({ role: "user", content: `[Form submitted] ${app.summary} — confirmation ${app.confirmation_number}.\n${app.details}` }, { role: "assistant", content: `Application ${app.confirmation_number} received and routed to ${app.department}.` });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(app));
    } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (req.method === "POST" && req.url === "/tts") { // natural voice for voice mode; 404 when no key so the client falls back to the browser voice
    if (!process.env.ELEVENLABS_API_KEY) { res.writeHead(404).end(); return; }
    let text = "";
    try { let b = ""; for await (const c of req) b += c; ({ text } = JSON.parse(b)); if (typeof text !== "string" || !text.trim()) throw 0; } catch { res.writeHead(400).end("bad request"); return; }
    try {
      const voice = process.env.ELEVENLABS_VOICE || "21m00Tcm4TlvDq8ikWAM"; // Rachel
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`, {
        method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 2500), model_id: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5", voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
      for await (const chunk of r.body) res.write(chunk);
      res.end();
    } catch (e) { console.error("tts:", e.message); if (!res.headersSent) res.writeHead(502).end(); else res.end(); }
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
  if (req.method === "GET" && req.url.startsWith("/api/applications/")) {
    const r = checkStatus(decodeURIComponent(req.url.slice(18)));
    res.writeHead(r.error ? 404 : 200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
    return;
  }
  const pub = path.resolve("public");
  const file = path.resolve(pub, "." + (req.url === "/" ? "/index.html" : req.url.split("?")[0]));
  if (!file.startsWith(pub + path.sep)) return res.writeHead(404).end("not found");
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" }).end(data);
  });
});
// Only bind the port when run directly; test.js and ad-hoc scripts import this module and must not take over :8787.
if (import.meta.main) server.listen(PORT, () => console.log(`Santa Monica assistant → http://localhost:${PORT}`));
