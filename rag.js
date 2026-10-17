// Retrieval over (a) knowledge/<jurisdiction>/*.md chunks and (b) each jurisdiction's open-data catalog (CKAN today; DCAT/Socrata next).
// Every doc carries `jur` (jurisdiction id) and searches are scoped to the active jurisdiction + its county + the state.
// ponytail: BM25 in-process, no embeddings; swap in a vector store when the corpus outgrows RAM.
import fs from "node:fs";
import { JURS, jurById, scopeIds, dataDir } from "./jurisdictions.js";

/** portal id -> { id, type, url, site, jur } for every portal in the registry. */
export const PORTALS = Object.fromEntries(JURS.flatMap((j) => (j.portals ?? []).map((p) => [p.id, { ...p, jur: j.id }])));
const CKAN = PORTALS.santamonica.url;
const CATALOG_TTL_MS = 24 * 3600 * 1000;
const catalogFile = (portal) => `${dataDir(jurById(portal.jur))}/catalog-${portal.id}.json`;

// Tokens = light-stemmed words + bigrams of adjacent content words ("block_party", "dog_license"), so a distinctive phrase
// outweighs generic words like "permit" or "street" that match half the corpus. ponytail: suffix-strip stemmer, no NLP lib.
const STOP = new Set("a an the and or of to in on for with my i me you your is are be can do how what which when where who why it its this that at by from as about into over under up out if we our us they their there here any all get need want help please santa monica city".split(" "));
const stem = (t) => t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? (t.endsWith("ies") ? t.slice(0, -3) + "y" : /(sh|ch|x|z)es$/.test(t) ? t.slice(0, -2) : t.slice(0, -1)) : t;
const tokenize = (s, bigrams = true) => {
  const w = (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t)).map(stem), out = [...w];
  if (bigrams) for (let i = 0; i < w.length - 1; i++) out.push(w[i] + "_" + w[i + 1]);
  return out;
};
// Long spoken/minutes chunks get unigrams only: their bigram vocabulary was most of the heap and adds little over the date/doc filters.
const wantBigrams = (doc) => doc.kind !== "council_meeting";

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
  if (portal.type !== "ckan") throw new Error(`portal type ${portal.type} not supported yet (${portal.id})`); // dcat / socrata / hubsearch: Phase B
  const { results } = await ckan("package_search", { rows: 500 }, portal.url);
  const datasets = await Promise.all(results.map(async (p) => {
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
  fs.mkdirSync(dataDir(jurById(portal.jur)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetched_at: Date.now(), datasets }, null, 1));
  return datasets;
}
const indexedPortals = () => Object.values(PORTALS).filter((p) => p.index !== false);

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

// Incremental inverted index: add() appends one doc's postings, search() touches only the postings of the query's terms.
// No per-doc token maps are kept (that was ~2.5 GB for 30k transcript chunks) and nothing is rebuilt when more docs arrive.
class BM25 {
  constructor(k1 = 1.4, b = 0.75) { this.k1 = k1; this.b = b; this.docs = []; this.len = []; this.total = 0; this.post = new Map(); }
  add(doc, text) {
    const id = this.docs.push(doc) - 1, tf = new Map();
    for (const t of tokenize(text, wantBigrams(doc))) tf.set(t, (tf.get(t) ?? 0) + 1);
    let n = 0;
    for (const [t, f] of tf) { n += f; let p = this.post.get(t); if (!p) this.post.set(t, p = { ids: [], tfs: [] }); p.ids.push(id); p.tfs.push(f); }
    this.len.push(n); this.total += n;
  }
  search(query, k = 5, pred = () => true) {
    const N = this.docs.length, avg = this.total / Math.max(N, 1), acc = new Map();
    for (const t of new Set(tokenize(query))) {
      const p = this.post.get(t); if (!p) continue;
      const idf = Math.log(1 + (N - p.ids.length + 0.5) / (p.ids.length + 0.5)), { ids, tfs } = p;
      for (let j = 0; j < ids.length; j++) { const i = ids[j], f = tfs[j]; acc.set(i, (acc.get(i) ?? 0) + idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / avg))); }
    }
    const out = [];
    for (const [i, s] of acc) if (pred(this.docs[i])) out.push([s, i]);
    return out.sort((a, b) => b[0] - a[0]).slice(0, k).map(([score, i]) => ({ score: +score.toFixed(2), ...this.docs[i] }));
  }
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
  const knowledge = JURS.flatMap((j) => {
    const dir = `./knowledge/${j.id}`;
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).flatMap((f) => chunkMarkdown(`${dir}/${f}`).map((c) => ({ ...c, jur: j.id }))) : [];
  });
  const datasets = [];
  for (const p of indexedPortals()) {
    try { datasets.push(...(await loadCatalog(p)).map((d) => ({ ...d, jur: p.jur, portal: p.id }))); }
    catch (e) { console.error(`open data catalog ${p.id} unavailable:`, e.message); }
  }
  const docs = [
    ...knowledge.map((c) => ({ ...c, searchText: `${c.title} ${c.text}` })),
    ...datasets.map((d) => ({
      kind: "dataset", jur: d.jur, portal: d.portal, title: d.title, url: d.url, org: d.org, notes: d.notes, modified: d.modified,
      resources: d.resources.filter((r) => r.datastore).map(({ resource_id, name, fields }) => ({ resource_id, name, fields })),
      searchText: `${d.title} ${d.name.replace(/-/g, " ")} ${d.notes} ${d.tags.join(" ")} ${d.resources.flatMap((r) => [r.name, ...r.fields]).join(" ")}`,
    })),
  ];
  let index = new BM25(docs);
  const strip = ({ searchText, ...d }) => d;
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const byResource = new Map(datasets.flatMap((d) => d.resources.map((r) => [r.resource_id, { kind: "dataset", jur: d.jur, portal: d.portal, title: d.title, url: d.url, org: d.org }])));
  // scope: a jurisdiction id (itself + county + state), or null for everything (tests, single-city deployments)
  const inScope = (jur) => { const ids = scopeIds(jurById(jur)); return ids ? (d) => ids.includes(d.jur) : () => true; };
  const summaries = new Map();
  const results = new Map(); // ponytail: memo of query results (same array object for identical calls), cleared on addDocs, capped at 500
  const memo = (key, fn) => { if (!results.has(key)) { if (results.size >= 500) results.delete(results.keys().next().value); results.set(key, fn()); } return results.get(key); };
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
        const ok = inScope(jur);
        const main = index.search(query, k, (d) => ok(d) && d.kind !== "council_meeting" && d.kind !== "news");
        return [...main, ...index.search(query, 2, (d) => ok(d) && d.kind === "news" && d.date >= since(60))].map(strip);
      });
    },
    searchNews(query, k = 10, days = 0, jur = null) { return memo(`n|${jur}|${k}|${days}|${query}`, () => { const ok = inScope(jur); return index.search(query, k, (d) => ok(d) && d.kind === "news" && (!days || d.date >= since(days))).map(strip); }); },
    searchCouncil(query, k = 8, year = "", doc = "", jur = null) {
      return memo(`c|${jur}|${k}|${year}|${doc}|${query}`, () => {
        const ok = inScope(jur);
        const want = (d) => ok(d) && d.kind === "council_meeting" && (!year || d.meeting_date.startsWith(year)) && (!doc || d.doc === doc);
        if (doc) return index.search(query, k, want).map(strip);
        // no doc filter: balance the official record (agenda/minutes) against spoken transcript excerpts
        const half = Math.ceil(k / 2);
        return [...index.search(query, half, (d) => want(d) && d.doc !== "transcript"), ...index.search(query, k - half, (d) => want(d) && d.doc === "transcript")].map(strip);
      });
    },
    addDocs(more) { // dedupe by jur|url#part so a daily re-ingest doesn't double-index; returns how many were new. ponytail: full rebuild, fine for <100k docs
      const key = (d) => `${d.jur}|${d.url}#${d.part}`, seen = new Set(docs.map(key));
      let added = 0;
      for (const d of more) if (!seen.has(key(d))) { seen.add(key(d)); docs.push(d); added++; }
      if (added) { index = new BM25(docs); results.clear(); }
      return added;
    },
  };
}

const rowCache = new Map(); // ponytail: in-memory, 10-min TTL, capped at 500 entries; swap for a KV if more than one server instance exists
export async function queryDataset({ resource_id, q = "", filters = "", limit = 20, sort = "", portal = "santamonica" }) {
  const P = PORTALS[portal] ?? PORTALS.santamonica;
  if (P.type !== "ckan") throw new Error(`portal ${portal} (${P.type}) is not queryable yet`); // Phase B: socrata / dcat-file / arcgis
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
