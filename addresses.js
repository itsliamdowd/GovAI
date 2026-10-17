// Address autocomplete from each city's official Address Points GIS layer.
// Collected by `node warm.js addresses` into data/<jurisdiction>/addresses.json; served offline from that file.
import fs from "node:fs";
import { SERVED, dataDir } from "./jurisdictions.js";

const file = (j) => `${dataDir(j)}/addresses.json`;
const title = (s) => (s ?? "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** The city's address-point layer, found in its collected GIS catalog (no hardcoded URLs). Titles vary by city. */
function addressLayer(j) {
  try {
    const layers = JSON.parse(fs.readFileSync(`${dataDir(j)}/gis.json`, "utf8")).layers;
    const mine = layers.filter((l) => !/street lines|road|centerline|parcel|range|grid/i.test(l.title) && /\baddress(es)?( ?points?)?( view)?$/i.test(l.title.trim())); // "Address Points", "Pasadena CA Addresses view", "SiteAddress"
    return mine.find((l) => /points?/i.test(l.title))?.service ?? mine[0]?.service ?? null;
  } catch { return null; }
}

// Field schemas differ per city (st_number/st_name, AddressNum/RoadName, ADDR_ST_NMBR/ADDR_ST_NAME...). Prefer a
// full-address field; else compose number + prefix dir + name + type + suffix dir.
const pickField = (names, re) => names.find((n) => re.test(n)) ?? null;
function schema(fields) {
  const names = fields.map((f) => f.name);
  return {
    full: pickField(names, /^(st_)?full_?(st_)?addr(ess)?$|^fulladdress$|^full_address$|^addr$|^address$|^siteaddr(ess)?$|^situs_?addr(ess)?$/i),
    num: pickField(names, /^(addr_?)?(st_?)?(num(ber)?|nmbr)$|^house(_?num(ber)?)?$|^addressnum$|^st_number$|^add_?number$/i), // NENA: Add_Number
    pre: pickField(names, /^(addr_?st_?)?(pfx|prefix|pre_?dir|st_prefix|roadpredir|roadprefix|street_dir)$|^st_?predir$/i),
    name: pickField(names, /^(addr_?st_?)?(name|st_?name|roadname|street)$/i),
    type: pickField(names, /^(addr_?st_?)?(name_?sfx|st_?type|roadnametype|roadsuffix|street_?type|st_suffix)$|^st_?pos_?typ(e)?$/i),
    suf: pickField(names, /^(addr_?st_?)?(sfx|suf_?dir|roadsufdir|roadsuff_1|st_suffix_dir)$|^st_?posdir$/i),
    unit: pickField(names, /^(addr_?st_?)?(unit|st_unit|unitnumber)$/i),
    zip: pickField(names, /^(zip|zipcode|zip_?code|postal|zipc|post_?code)$/i),
  };
}

/** Collector: pages through the layer and writes a compact, deduped, sorted list. Network. */
export async function ingestAddresses(j, log = console.error) {
  const service = addressLayer(j);
  if (!service) return 0;
  const meta = await (await fetch(`${service}?f=json`, { signal: AbortSignal.timeout(60000) })).json();
  const sc = schema(meta.fields ?? []), page = Math.min(meta.maxRecordCount || 2000, 5000);
  // ponytail: the in-memory book is a linear scan; a county-wide layer (LA County eGIS: 2.7M rows, surfaced in LA City's GeoHub)
  // needs the SQLite store instead. Cap at 400k rows until that exists.
  const { count = 0 } = await (await fetch(`${service}/query?where=1%3D1&returnCountOnly=true&f=json`, { signal: AbortSignal.timeout(60000) })).json();
  if (count > 400000) { log(`addresses ${j.id}: ${count.toLocaleString()} rows in ${service} exceeds the 400k in-memory cap; skipped`); return 0; }
  if (!sc.full && !(sc.num && sc.name)) { log(`addresses ${j.id}: no usable address fields in ${service}`); return 0; }
  const outFields = [sc.full, sc.num, sc.pre, sc.name, sc.type, sc.suf, sc.unit, sc.zip].filter(Boolean).join(",");
  const seen = new Set(), rows = [];
  for (let offset = 0; ; offset += page) {
    const q = new URLSearchParams({ where: "1=1", outFields, orderByFields: meta.objectIdField ?? "OBJECTID", resultOffset: offset, resultRecordCount: page, returnGeometry: "false", f: "json" });
    const r = await fetch(`${service}/query?${q}`, { signal: AbortSignal.timeout(120000) });
    const { features = [], exceededTransferLimit } = await r.json();
    for (const { attributes: a } of features) {
      let base, unit = "";
      if (sc.full && a[sc.full]) {
        base = title(String(a[sc.full]).replace(/\s+/g, " ").trim());
      } else {
        if (!a[sc.num] || !a[sc.name]) continue;
        base = `${a[sc.num]} ${title([a[sc.pre], a[sc.name], a[sc.type], a[sc.suf]].map((x) => (x ?? "").toString().trim()).filter(Boolean).join(" "))}`;
        unit = (sc.unit && a[sc.unit] ? String(a[sc.unit]) : "").replace(/^(APARTMENT|APT|UNIT|SUITE|STE|SPACE|SPC|BLDG|#)\.?\s*/i, "").trim();
      }
      if (!/^\d/.test(base)) continue;
      for (const addr of unit ? [base, `${base} #${unit}`] : [base]) { // the building itself is always offered, then its units
        if (seen.has(addr)) continue;
        seen.add(addr); rows.push([addr, sc.zip ? String(a[sc.zip] ?? "") : ""]);
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
export const hasBook = (jurId) => books.has(jurId);

// Jurisdictions without a collected address book: live, bounded Nominatim lookup instead, so a Pasadena form only ever
// offers Pasadena addresses. ponytail: 1 req/s + 10-min cache; collect the county Address Points layer (node warm.js addresses) when a city needs offline/instant results.
const liveCache = new Map(); let lastLive = 0;
export async function liveAddresses(query, j, limit = 8) {
  if (!j || query.trim().length < 3) return [];
  const key = `${j.id}|${norm(query)}`;
  const hit = liveCache.get(key); if (hit && Date.now() - hit.t < 600e3) return hit.v;
  const wait = lastLive + 1100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastLive = Date.now();
  const [lat, lon] = j.center ?? [34.05, -118.25], r = j.kind === "county" ? 0.6 : 0.08;
  const [x0, y0, x1, y1] = j.bbox ?? [lon - r, lat - r, lon + r, lat + r];
  const params = new URLSearchParams({ q: `${query}, ${j.short}, CA`, format: "jsonv2", addressdetails: "1", limit: String(limit * 2), countrycodes: "us", dedupe: "1", viewbox: `${x0},${y1},${x1},${y0}`, bounded: "1" });
  let hits = [];
  try { const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { "User-Agent": "GovAI local-government assistant (address autocomplete)" }, signal: AbortSignal.timeout(9000) }); hits = res.ok ? await res.json() : []; } catch { hits = []; } // Nominatim answers in 1–9 s; the client's sequence guard drops stale results
  const want = new Set([j.short, ...(j.aliases ?? [])].map((a) => a.toLowerCase()));
  const seen = new Set(), v = [];
  for (const h of hits) {
    const a = h.address ?? {}; if (!a.house_number || !a.road) continue;
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? "";
    if (j.kind !== "county" && city && !want.has(city.toLowerCase())) continue; // inside the box but across the city line
    const address = `${a.house_number} ${a.road}`; if (seen.has(address)) continue; seen.add(address);
    v.push({ address, zip: a.postcode ?? "", city: city || j.short });
    if (v.length >= limit) break;
  }
  liveCache.set(key, { t: Date.now(), v });
  return v;
}
