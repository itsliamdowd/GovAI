// Phase-0 discovery for jurisdictions that have no agenda platform wired yet:
//   node tools/discover.mjs [county-id]        (default los-angeles-county; writes data/_discover/<county>.json and prints a table)
// For each draft city: fetch the homepage, look for a known vendor host (civicplus AgendaCenter, legistar, granicus, primegov, iqm2,
// civicclerk, agendalink, destiny, civiclive, boarddocs, swagit/youtube for video), follow the most agenda-looking internal link, and
// dry-run the pdflist parser on it. The result is a *suggested* j.council config per city, to be pasted into jurisdictions-la.js WIRING
// after a human glance. Read-only against the web; nothing in the registry changes.
import fs from "node:fs";
import { SERVED } from "../jurisdictions.js";
import { fetchHtml, absUrl, BlockedError } from "../adapters/_http.js";
import { parseLinks } from "../adapters/pdflist.js";
import { parseCategories } from "../adapters/civicplus.js";

const county = process.argv[2] ?? "los-angeles-county";
const cities = SERVED.filter((j) => j.county === county && !j.council?.platform);
const VENDOR = [
  [/\/AgendaCenter\b/i, "civicplus"], [/([a-z0-9-]+)\.legistar\.com/i, "legistar"], [/([a-z0-9-]+)\.granicus\.com/i, "granicus"], [/([a-z0-9-]+)\.primegov\.com/i, "primegov"],
  [/([a-z0-9-]+)\.iqm2\.com/i, "iqm2"], [/([a-z0-9-]+)\.api\.civicclerk\.com|([a-z0-9-]+)\.civicclerk\.com/i, "civicclerk"], [/agendalink\.app\/[^/]+\/([a-z0-9-]+)/i, "agendalink"],
  [/destinyhosted\.com\/(\d+)/i, "destiny"], [/hosted\d*\.civiclive\.com/i, "civiclive"], [/go\.boarddocs\.com\/ca\/([a-z0-9-]+)/i, "boarddocs"], [/novusagenda\.com\/agendapublic/i, "novus"],
  [/escribemeetings\.com/i, "escribe"], [/laserfiche|WebLink\/Browse\.aspx/i, "laserfiche"], [/granicusideas\.com/i, "granicusideas"],
];
const VIDEO = [[/youtube\.com\/(channel\/UC[\w-]{20,}|@[\w.-]+|user\/[\w-]+|c\/[\w-]+)/i, "youtube"], [/swagit\.com/i, "swagit"], [/vimeo\.com\/[\w/]+/i, "vimeo"], [/cablecast|\.cablecast\.tv/i, "cablecast"], [/granicus\.com\/(MediaPlayer|ViewPublisher)/i, "granicus-video"]];
const AGENDA_LINK = /agenda|minutes|meeting|council/i;

async function probe(j) {
  const out = { id: j.id, site: j.site, vendors: {}, video: [], agendaPages: [], pdflist: null, error: null };
  let html;
  try { html = await fetchHtml(j.site, { timeout: 30000, retries: 1 }); } catch (e) { out.error = e instanceof BlockedError ? "403 (bot wall)" : e.message.slice(0, 80); return out; }
  const hrefs = [...html.matchAll(/href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)].map((m) => ({ url: absUrl(m[1], j.site), text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() })).filter((l) => l.url);
  for (const l of hrefs) {
    for (const [re, name] of VENDOR) { const m = l.url.match(re); if (m) out.vendors[name] = out.vendors[name] ?? (m[1] ?? l.url); }
    for (const [re, name] of VIDEO) { const m = l.url.match(re); if (m && !out.video.some((v) => v.url === m[0])) out.video.push({ kind: name, url: m[0] }); }
  }
  const sameHost = (u) => { try { return new URL(u).host.replace(/^www\./, "") === new URL(j.site).host.replace(/^www\./, ""); } catch { return false; } };
  const cands = hrefs.filter((l) => sameHost(l.url) && AGENDA_LINK.test(l.text + " " + l.url)).sort((a, b) => score(b) - score(a));
  function score(l) { const s = (l.text + " " + l.url).toLowerCase(); return (/agendas?\b/.test(s) ? 3 : 0) + (/minutes/.test(s) ? 2 : 0) + (/council/.test(s) ? 1 : 0) - (/calendar|event|news|video|archive\.aspx/.test(s) ? 2 : 0); }
  for (const c of cands.slice(0, 3)) {
    try {
      const page = await fetchHtml(c.url, { timeout: 30000, retries: 1 });
      for (const [re, name] of VENDOR) { const m = page.match(re); if (m) out.vendors[name] = out.vendors[name] ?? (m[1] ?? m[0]); }
      for (const [re, name] of VIDEO) { const m = page.match(re); if (m && !out.video.some((v) => v.url === m[0])) out.video.push({ kind: name, url: m[0] }); }
      const cats = /AgendaCenter/.test(c.url) ? parseCategories(page) : [];
      const recs = parseLinks(page, { url: c.url, body: "City Council" }, { id: j.id, council: { since: String(new Date().getFullYear() - 2) } });
      out.agendaPages.push({ url: c.url, text: c.text.slice(0, 60), civicplusCategories: cats.length, pdflistRecords: recs.length, sample: recs[0] ? { date: recs[0].date, agenda: recs[0].agenda_url.slice(0, 90) } : null });
      if (recs.length >= 3 && (!out.pdflist || recs.length > out.pdflist.records)) out.pdflist = { url: c.url, records: recs.length };
    } catch (e) { out.agendaPages.push({ url: c.url, error: e.message.slice(0, 60) }); }
  }
  return out;
}

export function suggest(r) {
  const v = r.vendors;
  if (v.civicplus) return { platform: "civicplus", since: "2019", limit: 3000, label: "City Council" };
  if (v.legistar) return { platform: "legistar", client: v.legistar, body: "City Council", limit: 2000, label: "City Council" };
  if (v.primegov) return { platform: "primegov", client: v.primegov, since: "2019", limit: 3000, label: "City Council" };
  if (v.granicus) return { platform: "granicus", client: v.granicus, views: ["TODO view ids from ViewPublisher.php?view_id="], label: "City Council" };
  if (v.iqm2) return { platform: "iqm2", client: v.iqm2, note: "IQM2 sunsets 2026-12-31" };
  if (v.civicclerk) return { platform: "civicclerk", client: v.civicclerk, note: "adapter pending" };
  if (v.agendalink) return { platform: "agendalink", client: v.agendalink, note: "adapter pending (Next.js app)" };
  if (v.destiny) return { platform: "destiny", id: v.destiny, note: "adapter pending" };
  if (r.pdflist) return { platform: "pdflist", pages: [{ url: r.pdflist.url, body: "City Council" }], since: "2019", limit: 2000, label: "City Council" };
  return null;
}

const results = [];
const queue = [...cities];
await Promise.all(Array.from({ length: 6 }, async () => { for (let j; (j = queue.shift());) { const r = await probe(j); r.suggest = suggest(r); results.push(r); console.error(`${r.id}: ${r.error ?? (r.suggest?.platform ?? "?")} ${Object.keys(r.vendors).join(",")} video=${r.video.map((v) => v.kind).join(",")}`); } }));
results.sort((a, b) => a.id.localeCompare(b.id));
fs.mkdirSync("data/_discover", { recursive: true });
fs.writeFileSync(`data/_discover/${county}.json`, JSON.stringify(results, null, 1));
const tally = {}; for (const r of results) { const k = r.error ? "blocked/error" : r.suggest?.platform ?? "unknown"; tally[k] = (tally[k] ?? 0) + 1; }
console.log(`\n${results.length} cities probed → data/_discover/${county}.json`); console.log(tally);
for (const r of results) console.log(`${r.id.padEnd(22)} ${(r.error ?? r.suggest?.platform ?? "?").padEnd(14)} ${Object.entries(r.vendors).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(" ")} ${r.video.map((v) => v.url).join(" ").slice(0, 80)}`);
