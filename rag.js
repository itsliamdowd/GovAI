// Retrieval over (a) knowledge/<jurisdiction>/*.md chunks and (b) each jurisdiction's open-data catalog (CKAN today; DCAT/Socrata next).
// Every doc carries `jur` (jurisdiction id) and searches are scoped to the active jurisdiction + its county + the state.
// Index: SQLite FTS5 on disk (store.js, GOVAI_DB, default data/govai.db): bm25 ranking, phrase bigrams, jurisdiction facets. No embeddings.
import fs from "node:fs";
import { loadYouTubeDocs } from "./youtube.js";
import crypto from "node:crypto";
import { JURS, jurById, scopeIds, dataDir } from "./jurisdictions.js";
import { Store } from "./store.js";

/** portal id -> { id, type, url, site, jur } for every portal in the registry. */
export const PORTALS = Object.fromEntries(JURS.flatMap((j) => (j.portals ?? []).map((p) => [p.id, { ...p, jur: j.id }])));
const CKAN = PORTALS.santamonica.url;
const CATALOG_TTL_MS = 24 * 3600 * 1000;
const catalogFile = (portal) => `${dataDir(jurById(portal.jur))}/catalog-${portal.id}.json`;

export async function ckan(action, params, base = CKAN) {
  const url = `${base}/${action}?` + new URLSearchParams(params);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (!j.success) throw new Error(j.error?.message ?? `CKAN ${action} failed`);
  return j.result;
}

async function loadCatalog(portal, refresh = false) {
  const file = catalogFile(portal);
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!refresh || Date.now() - cached.fetched_at < CATALOG_TTL_MS) return cached.datasets;
  } catch { if (!refresh) throw new Error(`no ${file} — run \`node warm.js catalog\` to collect it`); }
  const datasets = portal.type === "dcat" ? await dcatCatalog(portal) : await ckanCatalog(portal);
  fs.mkdirSync(dataDir(jurById(portal.jur)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetched_at: Date.now(), datasets }, null, 1));
  return datasets;
}
const indexedPortals = () => Object.values(PORTALS).filter((p) => p.index !== false);
const shortId = (u) => crypto.createHash("sha1").update(u).digest("hex").slice(0, 12);
/** DCAT-US data.json (ArcGIS Hub feeds, Socrata, the City of San Diego inventory) -> the same dataset shape as CKAN. Files/SODA/ArcGIS are queried by queryDataset. */
export function dcatDatasets(dataset, portal) {
  return dataset.map((d) => {
    // Socrata: the 4x4 id sits in the identifier (…/api/views/xxxx-xxxx) or a /resource/ URL; SODA lives at /resource/<id>.json
    const sodaId = String(d.identifier ?? "").match(/\/api\/views\/([a-z0-9]{4}-[a-z0-9]{4})/)?.[1] ?? (d.distribution ?? []).map((x) => (x.downloadURL ?? x.accessURL ?? "").match(/\/resource\/([a-z0-9]{4}-[a-z0-9]{4})/)?.[1]).find(Boolean);
    const origin = sodaId ? String(d.landingPage ?? d.identifier).match(/^https?:\/\/[^/]+/)?.[0] : null;
    const resources = sodaId && origin ? [{ resource_id: sodaId, name: d.title, format: "soda", datastore: true, access: { type: "soda", url: `${origin}/resource/${sodaId}.json` }, fields: [] }]
      : (d.distribution ?? []).map((x) => {
        const url = x.downloadURL ?? x.accessURL ?? ""; if (!url) return null;
        const fmt = String(x.format ?? x.mediaType ?? "").toLowerCase();
        const access = /\/(FeatureServer|MapServer)\/\d+$/.test(url) ? { type: "arcgis", url }
          : /csv|json/.test(fmt) && !/zip|shp|gdb|kml|xml/.test(fmt) ? { type: "file", url, format: /csv/.test(fmt) ? "csv" : "json" } : null;
        return access ? { resource_id: shortId(url), name: x.title ?? x.description ?? fmt, format: fmt, datastore: true, access, fields: [] } : null;
      }).filter(Boolean);
    const slug = String(d.identifier ?? d.title).split("/").pop();
    return {
      name: slug, title: d.title, notes: String(d.description ?? "").replace(/<[^>]+>/g, " ").slice(0, 600),
      tags: d.keyword ?? [], org: d.publisher?.name ?? "", modified: d.modified?.slice(0, 10),
      url: d.landingPage ?? (portal.datasetUrl ? `${portal.datasetUrl}${slug}/` : resources[0]?.access.url ?? portal.site), resources,
    };
  }).filter((d) => d.resources.length);
}
async function dcatCatalog(portal) {
  const r = await fetch(portal.url, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`${r.status} ${portal.url}`);
  return dcatDatasets((await r.json()).dataset ?? [], portal);
}
async function ckanCatalog(portal) {
  const { results } = await ckan("package_search", { rows: 500 }, portal.url);
  return Promise.all(results.map(async (p) => {
    const resources = await Promise.all((p.resources ?? []).map(async (r) => {
      let fields = [];
      if (r.datastore_active) {
        try { fields = (await ckan("datastore_search", { resource_id: r.id, limit: 0 }, portal.url)).fields.map((f) => f.id).filter((f) => f !== "_id"); } catch (e) { console.warn(`fields for ${r.id}: ${e.message}`); }
      }
      return { resource_id: r.id, name: r.name, format: r.format, datastore: !!r.datastore_active, fields };
    }));
    return {
      name: p.name, title: p.title, notes: (p.notes ?? "").slice(0, 600),
      tags: (p.tags ?? []).map((t) => t.name), org: p.organization?.title ?? "",
      modified: p.metadata_modified?.slice(0, 10), url: `${portal.site}/dataset/${p.name}`, resources,
    };
  }));
}

function chunkMarkdown(file) {
  const text = fs.readFileSync(file, "utf8");
  const chunks = [];
  let heading = "";
  for (const block of text.split(/\n(?=## )/)) {
    const m = block.match(/^## (.*)/);
    if (!m) continue; // file title / preamble: not a citable section
    heading = m[1];
    // The section's "Source: <url>" line becomes the url of EVERY chunk cut from it (so split sections still cite correctly).
    const url = block.match(/^Source: (https?:\/\/\S+)/m)?.[1] ?? "";
    const push = (text) => chunks.push({ kind: "knowledge", title: heading, text, source: file, url });
    // split long sections at bullet boundaries so each chunk stays ~<900 chars
    let cur = "";
    for (const line of block.replace(/^Source: .*$/m, "").split("\n")) {
      if (cur.length + line.length > 900 && cur.trim()) { push(cur.trim()); cur = ""; }
      cur += line + "\n";
    }
    if (cur.trim()) push(cur.trim());
  }
  return chunks;
}

// Query result cache: the model re-asks the same thing across turns and tools fan out 2–3 searches per call.
// ponytail: 256-entry LRU in a Map, cleared whenever docs are added; make it per-kind if churn gets high.
const QCACHE_MAX = 256;

/** The only network path for catalogs; called by warm.js. Returns all datasets across indexed portals. */
export async function refreshCatalog() {
  const out = [];
  for (const p of indexedPortals()) { try { out.push(...(await loadCatalog(p, true))); } catch (e) { console.error(`catalog ${p.id}: ${e.message}`); } }
  return out;
}

export async function buildIndex() {
  // hand-written knowledge/<jur>/*.md plus crawled data/knowledge/<jur>/*.md (crawl.js; gitignored, same "## heading / Source: url" format)
  const knowledge = JURS.flatMap((j) => [`./knowledge/${j.id}`, `./data/knowledge/${j.id}`].flatMap((dir) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).flatMap((f) => chunkMarkdown(`${dir}/${f}`).map((c) => ({ ...c, jur: j.id }))) : []));
  const datasets = [];
  for (const p of indexedPortals()) {
    try { datasets.push(...(await loadCatalog(p)).map((d) => ({ ...d, jur: p.jur, portal: p.id }))); }
    catch (e) { console.error(`open data catalog ${p.id} unavailable:`, e.message); }
  }
  const docs = [
    ...loadYouTubeDocs(),
    ...knowledge.map((c) => ({ ...c, searchText: `${c.title} ${c.text}` })),
    ...datasets.map((d) => ({
      kind: "dataset", jur: d.jur, portal: d.portal, title: d.title, url: d.url, org: d.org, notes: d.notes, modified: d.modified,
      resources: d.resources.filter((r) => r.datastore).map(({ resource_id, name, fields }) => ({ resource_id, name, fields })),
      searchText: `${d.title} ${d.name.replace(/-/g, " ")} ${d.notes} ${d.tags.join(" ")} ${d.resources.flatMap((r) => [r.name, ...r.fields]).join(" ")}`,
    })),
  ];
  const store = new Store();
  store.addDocs(docs); // knowledge + catalogs: unchanged content is a hash no-op, edited sections are upserted
  const scope = (jur) => scopeIds(jurById(jur)); // [jur, county, state] or null = everything
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const byResource = new Map(datasets.flatMap((d) => d.resources.map((r) => [r.resource_id, { kind: "dataset", jur: d.jur, portal: d.portal, title: d.title, url: d.url, org: d.org }])));
  for (const d of datasets) for (const r of d.resources) if (r.access) RESOURCE_ACCESS.set(r.resource_id, r.access);
  const summaries = new Map();
  const results = new Map(); // query result cache (see QCACHE_MAX): same array object for identical calls, cleared on addDocs
  const memo = (key, fn) => { if (!results.has(key)) { if (results.size >= QCACHE_MAX) results.delete(results.keys().next().value); results.set(key, fn()); } return results.get(key); };
  return {
    datasetCount: datasets.length,
    datasetFor(resource_id) { return byResource.get(resource_id); },
    catalogSummary(jur = "santa-monica") {
      if (!summaries.has(jur)) summaries.set(jur, datasets.filter((d) => d.jur === jur).map((d) => `- ${d.title} (${d.modified})`).join("\n"));
      return summaries.get(jur);
    },
    // general search: knowledge + datasets + GIS layers, plus up to 2 recent news hits so current events surface without a second call
    search(query, k = 6, jur = null) {
      return memo(`s|${jur}|${k}|${query}`, () => {
        const jurs = scope(jur);
        return [...store.search(query, { k, jurs, notKinds: ["council_meeting", "news"] }), ...store.search(query, { k: 2, jurs, kinds: ["news"], since: since(60) })];
      });
    },
    searchNews(query, k = 10, days = 0, jur = null) { return memo(`n|${jur}|${k}|${days}|${query}`, () => store.search(query, { k, jurs: scope(jur), kinds: ["news"], since: days ? since(days) : null })); },
    searchCouncil(query, k = 8, year = "", doc = "", jur = null) {
      return memo(`c|${jur}|${k}|${year}|${doc}|${query}`, () => {
        const base = { jurs: scope(jur), kinds: ["council_meeting"], year: year || null };
        if (doc) return store.search(query, { ...base, k, doc });
        // no doc filter: balance the official record (agenda/minutes) against spoken transcript excerpts
        const half = Math.ceil(k / 2);
        return [...store.search(query, { ...base, k: half, notDoc: "transcript" }), ...store.search(query, { ...base, k: k - half, doc: "transcript" })];
      });
    },
    addDocs(more) { // upsert by jur|url#part (store.js keyOf); returns how many keys were new. Edited chunks are rewritten in place.
      const added = store.addDocs(more);
      if (store.dirty) { results.clear(); store.dirty = false; }
      return added;
    },
    store,
  };
}

const rowCache = new Map(); // ponytail: in-memory, 10-min TTL, capped at 500 entries; swap for a KV if more than one server instance exists
const RESOURCE_ACCESS = new Map(); // resource_id -> { type: file|soda|arcgis, url, format } for non-CKAN portals (filled by buildIndex)
const FILE_CAP = 25e6, FILE_TTL = 864e5;
/** Minimal RFC 4180 CSV -> array of objects (quoted fields, embedded commas/newlines). ponytail: whole-file parse, fine under FILE_CAP. */
export function parseCsv(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}
async function fileRows(access, portalJur) {
  const dir = `${dataDir(jurById(portalJur))}/files`, file = `${dir}/${shortId(access.url)}.json`;
  try { const c = JSON.parse(fs.readFileSync(file, "utf8")); if (Date.now() - c.fetched_at < FILE_TTL) return c.rows; } catch {}
  const r = await fetch(access.url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`${r.status} ${access.url}`);
  const len = +r.headers.get("content-length"); if (len > FILE_CAP) throw new Error(`file is ${Math.round(len / 1e6)} MB, over the ${FILE_CAP / 1e6} MB cap; use the portal directly: ${access.url}`);
  const text = await r.text(); if (text.length > FILE_CAP) throw new Error(`file over the ${FILE_CAP / 1e6} MB cap; use the portal directly: ${access.url}`);
  let rows;
  if (access.format === "csv") rows = parseCsv(text);
  else { const j = JSON.parse(text); rows = Array.isArray(j) ? j : j.type === "FeatureCollection" ? j.features.map((f) => f.properties) : j.data ?? j.rows ?? j.records ?? []; }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetched_at: Date.now(), rows }));
  return rows;
}
/** Query a dataset resource. CKAN datastores query live; DCAT file distributions are downloaded once and filtered here; Socrata uses SODA; ArcGIS layers use the REST query. */
export async function queryDataset({ resource_id, q = "", filters = "", limit = 20, sort = "", portal = "santamonica" }) {
  const P = PORTALS[portal] ?? PORTALS.santamonica, access = RESOURCE_ACCESS.get(resource_id);
  const lim = Math.min(Math.max(1, limit), 100), f = filters ? JSON.parse(filters) : {};
  if (access?.type === "file") {
    const rows = await fileRows(access, P.jur), terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    let out = rows.filter((r) => Object.entries(f).every(([k, v]) => String(r[k] ?? "").toLowerCase() === String(v).toLowerCase()) && (!terms.length || terms.every((t) => JSON.stringify(r).toLowerCase().includes(t))));
    if (sort) { const [k, dir] = sort.split(/\s+/); out.sort((a, b) => (isNaN(+a[k]) || isNaN(+b[k]) ? String(a[k] ?? "").localeCompare(String(b[k] ?? "")) : +a[k] - +b[k]) * (dir === "desc" ? -1 : 1)); }
    return { total: out.length, fields: Object.keys(rows[0] ?? {}).map((k) => `${k}:text`), records: out.slice(0, lim), note: `filtered locally from ${access.url}` };
  }
  if (access?.type === "soda") {
    const params = { $limit: String(lim) }; if (q) params.$q = q; if (sort) params.$order = sort; if (Object.keys(f).length) params.$where = Object.entries(f).map(([k, v]) => `${k}='${String(v).replace(/'/g, "''")}'`).join(" AND ");
    const r = await fetch(`${access.url}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${r.status} ${access.url}`);
    const rows = await r.json();
    return { total: rows.length, fields: Object.keys(rows[0] ?? {}).map((k) => `${k}:text`), records: rows };
  }
  if (access?.type === "arcgis") {
    const where = Object.keys(f).length ? Object.entries(f).map(([k, v]) => `${k}='${String(v).replace(/'/g, "''")}'`).join(" AND ") : "1=1";
    const r = await fetch(`${access.url}/query?${new URLSearchParams({ where, outFields: "*", returnGeometry: "false", resultRecordCount: String(lim), f: "json", ...(sort ? { orderByFields: sort } : {}) })}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message);
    const rows = (j.features ?? []).map((x) => x.attributes); return { total: rows.length, fields: (j.fields ?? []).map((x) => `${x.name}:${x.type.replace("esriFieldType", "")}`), records: rows };
  }
  if (P.type !== "ckan") throw new Error(`resource ${resource_id} has no queryable access on portal ${portal}`);
  const params = { resource_id, limit: Math.min(Math.max(1, limit), 100) };
  if (q) params.q = q;
  if (sort) params.sort = sort;
  if (filters) { JSON.parse(filters); params.filters = filters; }
  const key = JSON.stringify({ ...params, portal });
  const hit = rowCache.get(key);
  if (hit && Date.now() - hit.t < 600e3) return hit.v;
  const r = await ckan("datastore_search", params, P.url);
  const v = { total: r.total, fields: r.fields.map((f) => `${f.id}:${f.type}`), records: r.records };
  rowCache.set(key, { t: Date.now(), v });
  if (rowCache.size > 500) rowCache.delete(rowCache.keys().next().value); // oldest out
  return v;
}
