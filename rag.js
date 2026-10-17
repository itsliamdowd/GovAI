// Retrieval over (a) knowledge/*.md chunks and (b) the data.santamonica.gov CKAN catalog.
// ponytail: BM25 in-process, no embeddings; swap in a vector store when the corpus outgrows RAM.
import fs from "node:fs";
import { loadYouTubeDocs } from "./youtube.js";

const CKAN = "https://data.santamonica.gov/api/3/action";
const PORTALS = { santamonica: CKAN, california: "https://data.ca.gov/api/3/action" };
const CATALOG_FILE = "./data/catalog.json";
const CATALOG_TTL_MS = 24 * 3600 * 1000;

// Tokens = light-stemmed words + bigrams of adjacent content words ("block_party", "dog_license"), so a distinctive phrase
// outweighs generic words like "permit" or "street" that match half the corpus. ponytail: suffix-strip stemmer, no NLP lib.
const STOP = new Set("a an the and or of to in on for with my i me you your is are be can do how what which when where who why it its this that at by from as about into over under up out if we our us they their there here any all get need want help please santa monica city".split(" "));
const stem = (t) => t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? (t.endsWith("ies") ? t.slice(0, -3) + "y" : /(sh|ch|x|z)es$/.test(t) ? t.slice(0, -2) : t.slice(0, -1)) : t;
const tokenize = (s) => {
  const w = (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t)).map(stem), out = [...w];
  for (let i = 0; i < w.length - 1; i++) out.push(w[i] + "_" + w[i + 1]);
  return out;
};

export async function ckan(action, params, base = CKAN) {
  const url = `${base}/${action}?` + new URLSearchParams(params);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (!j.success) throw new Error(j.error?.message ?? `CKAN ${action} failed`);
  return j.result;
}

async function loadCatalog() {
  try {
    const cached = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    if (Date.now() - cached.fetched_at < CATALOG_TTL_MS) return cached.datasets;
  } catch {}
  const { results } = await ckan("package_search", { rows: 500 });
  const datasets = await Promise.all(results.map(async (p) => {
    const resources = await Promise.all((p.resources ?? []).map(async (r) => {
      let fields = [];
      if (r.datastore_active) {
        try { fields = (await ckan("datastore_search", { resource_id: r.id, limit: 0 })).fields.map((f) => f.id).filter((f) => f !== "_id"); } catch (e) { console.warn(`fields for ${r.id}: ${e.message}`); }
      }
      return { resource_id: r.id, name: r.name, format: r.format, datastore: !!r.datastore_active, fields };
    }));
    return {
      name: p.name, title: p.title, notes: (p.notes ?? "").slice(0, 600),
      tags: (p.tags ?? []).map((t) => t.name), org: p.organization?.title ?? "",
      modified: p.metadata_modified?.slice(0, 10), url: `https://data.santamonica.gov/dataset/${p.name}`, resources,
    };
  }));
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(CATALOG_FILE, JSON.stringify({ fetched_at: Date.now(), datasets }, null, 1));
  return datasets;
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

class BM25 {
  constructor(docs, k1 = 1.4, b = 0.75) {
    this.docs = docs; this.k1 = k1; this.b = b;
    this.tf = docs.map((d) => { const m = new Map(); for (const t of tokenize(d.searchText)) m.set(t, (m.get(t) ?? 0) + 1); return m; });
    this.len = this.tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(docs.length, 1);
    this.df = new Map();
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }
  search(query, k = 5, pred = () => true) {
    const N = this.docs.length, q = [...new Set(tokenize(query))];
    const scores = this.docs.map((_, i) => {
      let s = 0;
      for (const t of q) {
        const f = this.tf[i].get(t); if (!f) continue;
        const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
        s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / this.avg));
      }
      return s;
    });
    return scores.map((s, i) => [s, i]).filter(([s, i]) => s > 0 && pred(this.docs[i])).sort((a, b) => b[0] - a[0]).slice(0, k).map(([score, i]) => ({ score: +score.toFixed(2), ...this.docs[i] }));
  }
}

export async function buildIndex() {
  const knowledge = fs.readdirSync("./knowledge").filter((f) => f.endsWith(".md")).flatMap((f) => chunkMarkdown(`./knowledge/${f}`));
  let datasets = [];
  try { datasets = await loadCatalog(); } catch (e) { console.error("open data catalog unavailable:", e.message); }
  const docs = [
    ...loadYouTubeDocs(),
    ...knowledge.map((c) => ({ ...c, searchText: `${c.title} ${c.text}` })),
    ...datasets.map((d) => ({
      kind: "dataset", title: d.title, url: d.url, org: d.org, notes: d.notes, modified: d.modified,
      resources: d.resources.filter((r) => r.datastore).map(({ resource_id, name, fields }) => ({ resource_id, name, fields })),
      searchText: `${d.title} ${d.name.replace(/-/g, " ")} ${d.notes} ${d.tags.join(" ")} ${d.resources.flatMap((r) => [r.name, ...r.fields]).join(" ")}`,
    })),
  ];
  let index = new BM25(docs);
  const strip = ({ searchText, ...d }) => d;
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const byResource = new Map(datasets.flatMap((d) => d.resources.map((r) => [r.resource_id, { kind: "dataset", title: d.title, url: d.url, org: d.org }])));
  return {
    datasetCount: datasets.length,
    datasetFor(resource_id) { return byResource.get(resource_id); },
    catalogSummary: datasets.map((d) => `- ${d.title} (${d.modified})`).join("\n"),
    // general search: knowledge + datasets + GIS layers, plus up to 2 recent news hits so current events surface without a second call
    search(query, k = 6) {
      const main = index.search(query, k, (d) => d.kind !== "council_meeting" && d.kind !== "news");
      return [...main, ...index.search(query, 2, (d) => d.kind === "news" && d.date >= since(60))].map(strip);
    },
    searchNews(query, k = 10, days = 0) { return index.search(query, k, (d) => d.kind === "news" && (!days || d.date >= since(days))).map(strip); },
    searchCouncil(query, k = 8, year = "", doc = "") {
      const want = (d) => d.kind === "council_meeting" && (!year || d.meeting_date.startsWith(year)) && (!doc || d.doc === doc);
      if (doc) return index.search(query, k, want).map(strip);
      // no doc filter: balance the official record (agenda/minutes) against spoken transcript excerpts
      const half = Math.ceil(k / 2);
      return [...index.search(query, half, (d) => want(d) && d.doc !== "transcript"), ...index.search(query, k - half, (d) => want(d) && d.doc === "transcript")].map(strip);
    },
    addDocs(more) { // dedupe by url#part so a daily re-ingest doesn't double-index; ponytail: full rebuild, fine for <100k docs
      const key = (d) => `${d.url}#${d.part}`, seen = new Set(docs.map(key));
      for (const d of more) if (!seen.has(key(d))) { seen.add(key(d)); docs.push(d); }
      index = new BM25(docs);
    },
  };
}

const rowCache = new Map(); // ponytail: in-memory, 10-min TTL, unbounded; swap for an LRU/KV if it grows past RAM
export async function queryDataset({ resource_id, q = "", filters = "", limit = 20, sort = "", portal = "santamonica" }) {
  const params = { resource_id, limit: Math.min(Math.max(1, limit), 100) };
  if (q) params.q = q;
  if (sort) params.sort = sort;
  if (filters) { JSON.parse(filters); params.filters = filters; }
  const key = JSON.stringify({ ...params, portal });
  const hit = rowCache.get(key);
  if (hit && Date.now() - hit.t < 600e3) return hit.v;
  const r = await ckan("datastore_search", params, PORTALS[portal] ?? CKAN);
  const v = { total: r.total, fields: r.fields.map((f) => `${f.id}:${f.type}`), records: r.records };
  rowCache.set(key, { t: Date.now(), v });
  return v;
}
