// Turn data/discover/<id>.json probes into data/discovered.json, which jurisdictions.js overlays onto draft entries
// at load time. No source-file editing. Rules are conservative: only fill fields the registry leaves empty.
//   node apply-discover.js          # rebuild from every probe on disk
import fs from "node:fs";
import { SERVED } from "./jurisdictions.js";

const DIR = "./data/discover", OUT = "./data/discovered.json";
const out = {}, stats = { probed: 0, council: 0, youtube: 0, gis: 0 };
for (const j of SERVED) {
  let f; try { f = JSON.parse(fs.readFileSync(`${DIR}/${j.id}.json`, "utf8")); } catch { continue; }
  stats.probed++;
  const d = {};
  if (f.legistar?.client) {
    const bodies = f.legistar.bodies ?? [];
    const body = bodies.find((b) => /^(city )?council$/i.test(b)) ?? bodies.find((b) => /council/i.test(b) && !/committee|sub|redevelopment|successor|housing authority/i.test(b)) ?? bodies[0];
    if (body) { d.council = { platform: "legistar", client: f.legistar.client, body, label: "City Council", limit: 2000 }; stats.council++; }
  } else if (f.granicus?.host && f.granicus.views?.length) {
    const client = f.granicus.host.replace(/\.granicus\.com$/, "");
    const views = f.granicus.views.filter((v) => !v.title || /council/i.test(v.title) || f.granicus.views.length === 1).slice(0, 3);
    d.council = { platform: "granicus", client, views: (views.length ? views : f.granicus.views.slice(0, 1)).map((v) => ({ id: v.view_id ?? v.id, body: "City Council" })), label: "City Council", limit: 2000 };
    stats.council++;
  }
  // YouTube: the probe matched the city name in channel OR video title; require it in the channel name itself and skip
  // obvious non-city channels (school districts, churches, news, neighboring agencies), else we'd ingest the wrong meetings.
  const city = new RegExp(j.short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const yt = (f.youtube ?? []).find((y) => city.test(y.channel) && !/school|usd\b|district|church|news|county|chamber of commerce|realt|tv\s*news/i.test(y.channel));
  if (yt) { d.youtube = [yt.id]; stats.youtube++; }
  // Hub sites: the item search returns look-alikes (a Florida Lakewood, a Texas Bell County, a Costa Rica Coronado, consultant
  // project pages). Accept a feed only if (a) it's on the city's own domain, (b) the owning ArcGIS account names the city and the
  // host contains the city slug, or (c) the host follows a city-portal pattern like data-<slug>, <slug>gis, cityof<slug>, maps-<slug>.
  const slug = j.id.replace(/-/g, ""), shortSlug = j.short.toLowerCase().replace(/[^a-z]/g, "");
  const own = (j.domains ?? []).map((d) => d.toLowerCase());
  const pattern = new RegExp(`^(www\\.)?(cityof${slug}|data${slug}|opendata${slug}|gis${slug}|maps${slug}|hub${slug}|${slug}gis|${slug}ca|${slug}city|${slug}data|gishub${slug}|open-data-${slug}|data-${slug}|gis-${slug}|maps-${slug}|${slug})\\.`, "i");
  const junk = /wca\.app|arboraccess|universit|college|\.edu|csu|ucf|columbusstate|spotsy|ocfl|roseinstitute|final-project|emht|avalonia|smcmaps|lcri|entech|manatee|nccommerce|cmrpc|sierravista|cnecr|hlplanning|fehrandpeers|lametro|uscssi|bellcounty|county-emergency|vision-zero|neighborhood-watch|covid|air-quality|paving|town-square|comprehensive-plan|utility-network-meeting|datos|colectivo|lake-forest-park|bell-em|gisanddata/i;
  const otherSlugs = SERVED.filter((o) => o.id !== j.id).map((o) => o.id.replace(/-/g, "")).filter((o) => o.includes(slug) && o !== slug); // "westcovina" vs "covina"
  const hubs = (f.hub ?? []).filter((h) => {
    const host = new URL(h.url).host.toLowerCase(), flat = host.replace(/-/g, ""), owner = String(h.owner ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (junk.test(h.url)) return false;
    if (otherSlugs.some((o) => flat.includes(o) || owner.includes(o))) return false; // belongs to a longer-named city
    if (j.kind === "city" && /county/.test(owner + flat)) return false; // a county's portal that happens to share the name
    if (/\buc|ucirvine|ucla|ucsd|csu/.test(owner)) return false; // universities
    if (flat.includes(`cityof${slug}`) || owner.includes(`cityof${slug}`)) return true;
    // an ArcGIS Hub/opendata host that names the city and reads as a data/GIS portal (data-carsoncity, buena-park-gis-open-data-buenapark)
    if (/\.(hub|opendata)\.arcgis\.com$/.test(host) && (flat.includes(slug) || flat.includes(shortSlug)) && /gis|data|maps|portal/.test(flat.replace(/\.(hub|opendata)\.arcgis\.com$/, ""))) return true;
    if (own.some((d) => host === d || host.endsWith("." + d))) return true;
    if ((owner.includes(slug) || owner.includes(shortSlug) || owner.startsWith("cityof")) && (flat.includes(slug) || flat.includes(shortSlug))) return true;
    return pattern.test(host.replace(/-/g, "")) || pattern.test(host);
  });
  if (hubs.length) { d.gis = hubs.map((h) => ({ org: h.org, url: h.url })); d.gisHosts = [...new Set(hubs.map((h) => new URL(h.url).host))]; stats.gis++; }
  if (Object.keys(d).length) out[j.id] = { ...d, discovered_at: f.probed_at };
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`probes: ${stats.probed}; council configs: ${stats.council}; youtube channels: ${stats.youtube}; gis feeds: ${stats.gis}; wrote ${OUT} (${Object.keys(out).length} jurisdictions)`);
