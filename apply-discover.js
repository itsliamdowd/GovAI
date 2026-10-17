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
  if (f.youtube?.length) { d.youtube = [f.youtube[0].id]; stats.youtube++; } // the probe already required the city's name in the channel or title
  if (f.hub?.length) { d.gis = f.hub.map((h) => ({ org: h.org, url: h.url })); d.gisHosts = [...new Set(f.hub.map((h) => new URL(h.url).host))]; stats.gis++; }
  if (Object.keys(d).length) out[j.id] = { ...d, discovered_at: f.probed_at };
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`probes: ${stats.probed}; council configs: ${stats.council}; youtube channels: ${stats.youtube}; gis feeds: ${stats.gis}; wrote ${OUT} (${Object.keys(out).length} jurisdictions)`);
