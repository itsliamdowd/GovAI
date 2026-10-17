import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { buildIndex, queryDataset } from "./rag.js";
import { ingestCouncil } from "./council.js";
import { ingestTranscripts, clipWindow, citedMoments } from "./transcripts.js";

const PORT = Number(process.env.PORT) || 8787;
const APPS_FILE = "./data/applications.json";
const client = new Anthropic(); // ANTHROPIC_API_KEY from .env (npm start loads it)
// Default is Sonnet: the "Hackathon" workspace caps claude-opus-5-5 at 1 input token/min, so Opus 429s on every call.
// Raise that limit in console.anthropic.com → Settings → Limits, then set MODEL=claude-opus-5-5 in .env.
const MODEL = process.env.MODEL || "claude-sonnet-5-5";

const rag = await buildIndex();
console.log(`RAG index ready: ${rag.datasetCount} open datasets indexed`);
let council = { ready: false, ingested: [], upcoming: [], transcripts: 0 };
ingestCouncil((docs, meta) => { rag.addDocs(docs); council = { ...council, ready: true, ...meta }; console.log(`Council: ${meta.ingested.length} meetings (agendas+minutes), ${docs.length} chunks indexed`); })
  .catch((e) => console.error("council ingestion failed:", e.message));
ingestTranscripts((docs, videos) => { rag.addDocs(docs); council.transcripts = videos.filter((v) => docs.some((d) => d.url.includes(v.id))).length; console.log(`Transcripts: ${council.transcripts} meetings, ${docs.length} chunks indexed`); })
  .catch((e) => console.error("transcript ingestion failed (is yt-dlp installed?):", e.message));

const SYSTEM = `You are the City of Santa Monica's digital assistant: one front door to every city service, like america.gov but for a city.

What you do
- Answer anything about Santa Monica city government, services, permits, fees, rules, departments, parks, transit, trash, parking, housing, council, open data, and how to get things done.
- Take permit and service applications end to end: figure out which permit the resident actually needs, collect only the required fields through a natural conversation (one or two questions at a time), confirm a summary, then call submit_application. Give the confirmation number and what happens next.
- Look up application status with check_application_status when given a confirmation number.

How you find answers (retrieval first, always)
1. Call search_city_knowledge with the resident's question before answering anything factual. It returns the most relevant city knowledge chunks AND matching open datasets (with resource_ids and field names).
2. If a dataset can answer (fees, active permits, business licenses, police/fire calls, rents, parking rates, trees, EV chargers, budget, campaign finance, water, etc.), call query_dataset with the resource_id and a full-text q or filters, then answer from the rows. Cite the dataset by title with its URL.
3. For anything about City Council: what was decided, who voted how, what's on an agenda, what a councilmember or speaker actually said, upcoming meetings — call search_council_meetings. It searches agendas, official minutes (the record of the meeting, back to 2015) and meeting transcripts (YouTube captions, recent years) and returns dated excerpts with links. Use doc="minutes" for votes/decisions, doc="transcript" for quotes/what was said, empty for both. Quote dates; cite the minutes link or the timestamped video link. When you quote or paraphrase something said in a meeting, include the transcript excerpt's exact url (the youtube link with &t=) as a markdown link — the app turns it into a playable clip of that moment. Transcripts are auto-captions and may misspell names.
4. For anything time-sensitive the index doesn't cover (news, closures, current officeholders, meeting agendas, exact current hours), use web_search on santamonica.gov. Link the page.
5. Never invent fees, phone numbers, addresses or legal requirements. If you can't verify, say so and point to 311 ((310) 458-8411 / 311@santamonica.gov) or the owning department.

Style
- Plain-spoken and brief. Lead with the answer. Short paragraphs, short lists, markdown tables for tabular data. No filler, no "great question".
- You are a city information and intake service, not a lawyer. For disputes (evictions, citation appeals) explain the process and the office.
- When a resident describes a problem that 311 handles (pothole, missed pickup, graffiti, streetlight), offer to file it via submit_application with type "311_service_request".

Applications
Types for submit_application: building_permit, business_license, community_event_permit, film_permit, encroachment_permit, preferential_parking_permit, temporary_use_permit, sidewalk_vending_permit, home_share_license, dog_license, alarm_permit, bulky_item_pickup, 311_service_request, other.
Required for every application: applicant_name, email, phone. Collect address (project/event/service location) for everything except business_license (use business address) and dog_license (owner address). Ask for a date when the permit is time-bound (events, film, encroachment, pickups). Put everything else the department would need in details (event: attendance, venue, street closure, alcohol, amplified sound; building: scope, contractor, valuation; film: company, crew size, equipment, locations).

Open datasets available on data.santamonica.gov (search_city_knowledge finds the right one and its fields):
${rag.catalogSummary}`;

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
      },
      required: ["resource_id", "q", "filters", "sort", "limit"], additionalProperties: false,
    },
  },
  {
    name: "search_council_meetings",
    description: "Search Santa Monica City Council agendas, official minutes (2015-present) and meeting transcripts (YouTube captions). Returns dated excerpts with links (minutes PDF, agenda page, or timestamped video) plus upcoming meeting dates. Use for votes, decisions, agenda items, public hearings, what council or public speakers said.",
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
    max_uses: 3,
    allowed_domains: ["santamonica.gov", "permits.santamonica.gov", "data.santamonica.gov", "filmsantamonica.com", "bigbluebus.com", "smpl.org", "smgov.net"],
    user_location: { type: "approximate", city: "Santa Monica", region: "California", country: "US" },
  },
  {
    name: "submit_application",
    description: "File a permit application or service request with the City of Santa Monica. Only call after the applicant has confirmed the summarized details. Returns a confirmation number.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["building_permit", "business_license", "community_event_permit", "film_permit", "encroachment_permit", "preferential_parking_permit", "temporary_use_permit", "sidewalk_vending_permit", "home_share_license", "dog_license", "alarm_permit", "bulky_item_pickup", "311_service_request", "other"] },
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
  film_permit: ["Film Santa Monica", "Review within 5 business days; a location fee and insurance certificate will be requested."],
  encroachment_permit: ["Public Works, Engineering", "Review within 5 business days; traffic control plan may be required."],
  preferential_parking_permit: ["Finance, Parking Permits", "Proof of residency verified within 3 business days; permit mailed or available for pickup."],
  temporary_use_permit: ["Planning Division", "Review within 10 business days."],
  sidewalk_vending_permit: ["Finance / Code Enforcement", "Review within 10 business days; county health permit required for food."],
  home_share_license: ["Finance, Business License Office", "Review within 10 business days; host must reside on site."],
  dog_license: ["SMPD Animal Control", "Issued within 5 business days once rabies certificate is verified."],
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
  submit_application: async (input) => JSON.stringify(submitApplication(input)),
  check_application_status: async ({ confirmation_number }) => JSON.stringify(checkStatus(confirmation_number)),
};
const STATUS = {
  search_city_knowledge: (i) => `Searching city knowledge: ${i.query}`,
  query_dataset: () => "Querying data.santamonica.gov…",
  search_council_meetings: (i) => `Searching council agendas & minutes: ${i.query}`,
  submit_application: () => "Filing application…",
  check_application_status: () => "Looking up application…",
};

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
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    }, { maxRetries: 0, timeout: 120000 }); // no silent retry sleeps: a 429/529 surfaces to the user in <1s instead of a 2-minute "Thinking…"
    stream.on("text", (delta) => send({ type: "text", text: delta }));
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use") send({ type: "status", text: `Searching santamonica.gov: ${block.input?.query ?? ""}` });
      if (block.type === "tool_use") send({ type: "status", text: STATUS[block.name]?.(block.input) ?? "Working…" });
    });
    const message = await stream.finalMessage();
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason === "refusal") { send({ type: "text", text: "\n\nI can't help with that request. For city services, call 311." }); return; }
    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
      const clips = saveClipsFor(message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
      if (clips.length) send({ type: "clips", data: clips });
      return;
    }

    const results = await Promise.all(toolUses.map(async (t) => {
      try {
        const out = await runTool[t.name](t.input);
        if (t.name === "submit_application") send({ type: "application", data: JSON.parse(out) });
        if (t.name === "search_city_knowledge") send({ type: "sources", data: JSON.parse(out).map((d) => d.kind === "dataset" ? { kind: "dataset", title: d.title, url: d.url, org: d.org } : { kind: "knowledge", title: d.title, url: d.text?.match(/Source: (https?:\/\/\S+)/)?.[1] ?? "https://www.santamonica.gov" }) });
        if (t.name === "search_council_meetings") send({ type: "sources", data: [...new Map(JSON.parse(out).excerpts.map((d) => [d.url, { kind: "council", title: d.title, url: d.url }])).values()] });
        return { type: "tool_result", tool_use_id: t.id, content: out };
      } catch (e) {
        return { type: "tool_result", tool_use_id: t.id, is_error: true, content: String(e.message) };
      }
    }));
    messages.push({ role: "user", content: results });
  }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
http.createServer(async (req, res) => {
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
  if (req.method === "GET" && req.url === "/api/clips") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Object.values(loadClips()).sort((a, b) => b.cited_at.localeCompare(a.cited_at))));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/clips/")) {
    const c = loadClips()[decodeURIComponent(req.url.slice(11))];
    res.writeHead(c ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(c ?? { error: "clip not found" }));
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
}).listen(PORT, () => console.log(`Santa Monica assistant → http://localhost:${PORT}`));
