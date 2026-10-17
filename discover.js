// Probe each draft jurisdiction for the platforms we can ingest, and print registry fields to paste into jurisdictions.js
// after a human looks at them. Network only; never imported by the server.
//   node discover.js                 # every draft entry
//   node discover.js irvine anaheim  # specific ids
// Probes: Legistar Web API client, Granicus ViewPublisher RSS views, ArcGIS Hub site DCAT feed (via Hub search), YouTube
// channel for "<city> city council meeting" (yt-dlp), and the city site redirect. Results go to data/discover/<id>.json.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SERVED, jurById } from "./jurisdictions.js";

const run = promisify(execFile);
const UA = { "User-Agent": "Mozilla/5.0 (GovAI discover; +https://github.com/liamdowd/GovAI)" };
const ok = async (url, t = 15000) => { try { const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(t) }); return r.ok ? r : null; } catch { return null; } };
const slugs = (j) => [...new Set([j.id.replace(/-/g, ""), j.id, `cityof${j.id.replace(/-/g, "")}`, j.id.replace(/-/g, "") + "ca", j.short.toLowerCase().replace(/\s+/g, "")])];

async function legistar(j) {
  for (const s of slugs(j)) { const r = await ok(`https://webapi.legistar.com/v1/${s}/bodies?$top=3`); if (r) { const b = await r.json().catch(() => []); if (Array.isArray(b) && b.length) return { client: s, bodies: b.map((x) => x.BodyName) }; } }
  return null;
}
async function granicus(j) {
  for (const s of slugs(j)) {
    const views = [];
    for (let v = 1; v <= 8; v++) { const r = await ok(`https://${s}.granicus.com/ViewPublisherRSS.php?view_id=${v}&mode=agendas`, 10000); if (r) { const t = await r.text(); if (/<item/i.test(t)) views.push({ view_id: v, title: t.match(/<title>([^<]+)/)?.[1]?.trim() }); } }
    if (views.length) return { host: `${s}.granicus.com`, views };
  }
  return null;
}
async function hub(j) {
  // ArcGIS Online item search for the city's Hub sites (type "Hub Site Application"), then verify each has a DCAT feed.
  // hub.arcgis.com/api/v3/datasets?q= returns unrelated orgs for common city names, so it's not used.
  const city = new RegExp(j.short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const bad = /universit|college|school|transit|church|\bnj\b|texas|\btx\b|florida|esri\.com|geoxc|realt|water district/i;
  const r = await ok(`https://www.arcgis.com/sharing/rest/search?${new URLSearchParams({ f: "json", num: "12", q: `type:"Hub Site Application" AND (${j.short})` })}`, 30000);
  if (!r) return null;
  const { results = [] } = await r.json().catch(() => ({}));
  const out = [];
  for (const it of results) {
    const hay = `${it.title} ${it.url} ${it.owner}`;
    if (!city.test(hay) || bad.test(hay) || !it.url) continue;
    if (!/city of|open data|gis|data portal|hub/i.test(it.title) && !/cityof|gis/i.test(`${it.url} ${it.owner}`)) continue;
    const u = `${it.url.replace(/\/$/, "")}/api/feed/dcat-us/1.1.json`;
    if (await ok(u, 30000)) out.push({ org: it.title, url: u, owner: it.owner });
    if (out.length >= 2) break;
  }
  return out.length ? out : null;
}
async function youtube(j) {
  try {
    const { stdout } = await run("yt-dlp", ["--flat-playlist", "--print", "%(channel_id)s\t%(channel)s\t%(title)s", `ytsearch6:${j.short} ${j.kind === "county" ? "board of supervisors" : "city council"} meeting`], { maxBuffer: 5e6 });
    const seen = new Map();
    for (const l of stdout.trim().split("\n")) { const [id, ch, title] = l.split("\t"); if (id && new RegExp(j.short, "i").test(`${ch} ${title}`)) seen.set(id, { channel: ch, example: title }); }
    return seen.size ? [...seen].map(([id, v]) => ({ id, ...v })) : null;
  } catch { return null; }
}
async function site(j) { const r = await ok(j.site, 15000); return r ? { url: r.url, title: (await r.text()).match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() } : null; }

//   node discover.js --hub [ids...]   # re-run only the Hub probe and merge it into existing data/discover/<id>.json
const hubOnly = process.argv.includes("--hub");
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = ids.length ? ids.map(jurById).filter(Boolean) : hubOnly ? SERVED : SERVED.filter((j) => j.draft);
fs.mkdirSync("./data/discover", { recursive: true });
for (const j of targets) {
  const t0 = Date.now();
  if (hubOnly) {
    let prev = { id: j.id }; try { prev = JSON.parse(fs.readFileSync(`./data/discover/${j.id}.json`, "utf8")); } catch {}
    const h = await hub(j);
    fs.writeFileSync(`./data/discover/${j.id}.json`, JSON.stringify({ ...prev, hub: h, hub_probed_at: new Date().toISOString() }, null, 1));
    console.log(`${j.id}: ${h ? h.map((x) => x.url).join(" ") : "no hub"} (${Math.round((Date.now() - t0) / 1000)}s)`);
    continue;
  }
  const found = { id: j.id, probed_at: new Date().toISOString(), site: await site(j), legistar: await legistar(j), granicus: await granicus(j), hub: await hub(j), youtube: await youtube(j) };
  fs.writeFileSync(`./data/discover/${j.id}.json`, JSON.stringify(found, null, 1));
  const council = found.legistar ? `council: { platform: "legistar", client: "${found.legistar.client}", body: "<pick from ${found.legistar.bodies.slice(0, 3).join(" | ")}>", label: "City Council", limit: 200 }`
    : found.granicus ? `council: { platform: "granicus", host: "${found.granicus.host}", view_id: ${found.granicus.views[0].view_id}, label: "City Council", limit: 200 }` : "council: null";
  console.log(`\n// ${j.name} (${Math.round((Date.now() - t0) / 1000)}s)\n  ${council},\n  youtube: ${JSON.stringify((found.youtube ?? []).map((y) => y.id))}, // ${(found.youtube ?? []).map((y) => y.channel).join(", ") || "none found"}\n  portals: ${JSON.stringify((found.hub ?? []).map((h) => ({ id: j.id + "-hub", type: "dcat", url: h.url, site: h.url.replace(/\/api\/feed.*/, "") })))},\n  gis: ${JSON.stringify((found.hub ?? []).map((h) => ({ org: h.org, url: h.url })))},`);
}
