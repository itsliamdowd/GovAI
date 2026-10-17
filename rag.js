// Retrieval over (a) knowledge/*.md chunks and (b) the data.santamonica.gov CKAN catalog.
// ponytail: BM25 in-process, no embeddings; swap in a vector store when the corpus outgrows RAM.
import fs from "node:fs";

const CKAN = "https://data.santamonica.gov/api/3/action";
const CATALOG_FILE = "./data/catalog.json";
const CATALOG_TTL_MS = 24 * 3600 * 1000;

const tokenize = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);

export async function ckan(action, params) {
  const url = `${CKAN}/${action}?` + new URLSearchParams(params);
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
    if (m) heading = m[1];
    // split long sections at bullet boundaries so each chunk stays ~<900 chars
    let cur = "";
    for (const line of block.split("\n")) {
      if (cur.length + line.length > 900 && cur) { chunks.push({ kind: "knowledge", title: heading, text: cur.trim(), source: file }); cur = ""; }
      cur += line + "\n";
    }
    if (cur.trim()) chunks.push({ kind: "knowledge", title: heading, text: cur.trim(), source: file });
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
    ...knowledge.map((c) => ({ ...c, searchText: `${c.title} ${c.text}` })),
    ...datasets.map((d) => ({
      kind: "dataset", title: d.title, url: d.url, notes: d.notes, modified: d.modified,
      resources: d.resources.filter((r) => r.datastore).map(({ resource_id, name, fields }) => ({ resource_id, name, fields })),
      searchText: `${d.title} ${d.name.replace(/-/g, " ")} ${d.notes} ${d.tags.join(" ")} ${d.resources.flatMap((r) => [r.name, ...r.fields]).join(" ")}`,
    })),
  ];
  let index = new BM25(docs);
  const strip = ({ searchText, ...d }) => d;
  return {
    datasetCount: datasets.length,
    catalogSummary: datasets.map((d) => `- ${d.title} (${d.modified})`).join("\n"),
    search(query, k = 6) { return index.search(query, k, (d) => d.kind !== "council_meeting").map(strip); },
    searchCouncil(query, k = 6, year = "") { return index.search(query, k, (d) => d.kind === "council_meeting" && (!year || d.meeting_date.startsWith(year))).map(strip); },
    addDocs(more) { docs.push(...more); index = new BM25(docs); }, // ponytail: full rebuild, fine for <100k docs
  };
}

export async function queryDataset({ resource_id, q = "", filters = "", limit = 20, sort = "" }) {
  const params = { resource_id, limit: Math.min(Math.max(1, limit), 100) };
  if (q) params.q = q;
  if (sort) params.sort = sort;
  if (filters) { JSON.parse(filters); params.filters = filters; }
  const r = await ckan("datastore_search", params);
  return { total: r.total, fields: r.fields.map((f) => `${f.id}:${f.type}`), records: r.records };
}
