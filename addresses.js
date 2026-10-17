// Address autocomplete from each city's official Address Points GIS layer.
// Collected by `node warm.js addresses` into data/<jurisdiction>/addresses.json; served offline from that file.
import fs from "node:fs";
import { SERVED, dataDir } from "./jurisdictions.js";

const file = (j) => `${dataDir(j)}/addresses.json`;
const title = (s) => (s ?? "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** The city's Address Points layer, found in its collected GIS catalog (no hardcoded URLs). */
function addressLayer(j) {
  try {
    const layers = JSON.parse(fs.readFileSync(`${dataDir(j)}/gis.json`, "utf8")).layers;
    return layers.find((l) => /^address points$/i.test(l.title) && (j.gisHosts ?? []).some((h) => l.service.includes(h)))?.service;
  } catch { return null; }
}

/** Collector: pages through the layer (5000/page) and writes a compact, deduped, sorted list. Network. */
export async function ingestAddresses(j, log = console.error) {
  const service = addressLayer(j);
  if (!service) return 0;
  const seen = new Set(), rows = [];
  for (let offset = 0; ; offset += 5000) {
    const q = new URLSearchParams({ where: "1=1", outFields: "house,street_dir,street,street_type,unit,zip", orderByFields: "objectid", resultOffset: offset, resultRecordCount: 5000, returnGeometry: "false", f: "json" });
    const r = await fetch(`${service}/query?${q}`, { signal: AbortSignal.timeout(60000) });
    const { features = [], exceededTransferLimit } = await r.json();
    for (const { attributes: a } of features) {
      if (!a.house || !a.street) continue;
      const street = title([a.street_dir, a.street, a.street_type].filter(Boolean).join(" "));
      const base = `${a.house} ${street}`;
      const unit = (a.unit ?? "").replace(/^(APARTMENT|APT|UNIT|SUITE|STE|SPACE|SPC|BLDG|#)\.?\s*/i, "").trim();
      for (const addr of unit ? [base, `${base} #${unit}`] : [base]) { // the building itself is always offered, then its units
        if (seen.has(addr)) continue;
        seen.add(addr); rows.push([addr, a.zip ?? ""]);
      }
    }
    if (!exceededTransferLimit || !features.length) break;
  }
  rows.sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }));
  fs.mkdirSync(dataDir(j), { recursive: true });
  fs.writeFileSync(file(j), JSON.stringify({ fetched_at: Date.now(), source: service, addresses: rows }));
  log(`addresses ${j.id}: ${rows.length}`);
  return rows.length;
}

// ponytail: linear scan over ~60k strings per keystroke (~1 ms); switch to a trie if cities with 1M+ points are added.
const books = new Map(); // jurisdiction id -> [{ addr, zip, n (normalized), city }]
export function loadAddresses(j = null) {
  for (const jur of j ? [j] : SERVED) {
    try {
      const { addresses } = JSON.parse(fs.readFileSync(file(jur), "utf8"));
      books.set(jur.id, addresses.map(([addr, zip]) => ({ address: addr, zip, city: jur.short, n: norm(addr) })));
    } catch {}
  }
  return [...books.values()].reduce((a, b) => a + b.length, 0);
}

/** Prefix suggestions. "1685 ma" → 1685 Main St…; "main st" → every number on Main St (first 8). */
export function suggestAddresses(query, limit = 8, jurId = null) {
  const q = norm(query);
  if (q.length < 2) return [];
  const byNumber = /^\d/.test(q);
  const out = [];
  for (const [id, list] of books) {
    if (jurId && id !== jurId) continue;
    for (const a of list) {
      if (byNumber ? a.n.startsWith(q) : a.n.replace(/^\d+ /, "").startsWith(q)) { out.push(a); if (out.length >= limit) return out.map(strip); }
    }
  }
  return out.map(strip);
}
const strip = ({ n, ...a }) => a;
