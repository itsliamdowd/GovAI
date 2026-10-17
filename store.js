// SQLite FTS5 chunk store: the on-disk replacement for the in-process BM25 index in rag.js.
// Every producer keeps its exact `searchText`; we index normalize(searchText) (today's tokenizer: lowercase [a-z0-9]+,
// drop 1-char + stop words, suffix-s stem) as one FTS5 column so unigram vocabulary and rankings match the old index,
// and the old adjacent-word bigrams ("block_party") become FTS5 phrases ("block party") at query time.
// Filters (jurisdiction, kind, doc type, year) are zero-weight facet tokens in a second column, so a scoped search
// intersects postings instead of scanning every row. Upsert by key; unchanged content (same hash) is skipped.
// ponytail: one file, node:sqlite (built in, Node 22.5+), no ORM. Swap `rank` config if scoring needs retuning.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// City names are NOT stop words any more: the jurisdiction facet does that job for every city, see rag.js scope.
const STOP = new Set("a an the and or of to in on for with my i me you your is are be can do how what which when where who why it its this that at by from as about into over under up out if we our us they their there here any all get need want help please".split(" "));
const stem = (t) => t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? (t.endsWith("ies") ? t.slice(0, -3) + "y" : /(sh|ch|x|z)es$/.test(t) ? t.slice(0, -2) : t.slice(0, -1)) : t;
export const words = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
export const normalize = (s) => words(s).join(" ");
export const facet = (prefix, v) => prefix + String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const CORE = new Set(["kind", "jur", "doc", "meeting_date", "date", "part", "title", "url", "text", "searchText"]);
// Dedupe key: jur|url#part. GIS layers have no part but may share a landing url, so their REST service url stands in.
export const keyOf = (d) => `${d.jur}|${d.url}#${d.part ?? d.service ?? ""}`;

/** FTS5 MATCH string: every query term OR'd (plus adjacent-term phrases = the old bigrams), AND'd with facet groups. */
export function ftsQuery(query, facetGroups = []) {
  const w = words(query); if (!w.length) return null;
  const terms = new Set(w.map((t) => `"${t}"`));
  for (let i = 0; i < w.length - 1; i++) terms.add(`"${w[i]} ${w[i + 1]}"`);
  const ands = [`body:(${[...terms].join(" OR ")})`], nots = [];
  for (const g of facetGroups) {
    if (!g) continue;
    if (g.not) nots.push(`facets:${g.not}`);
    else { const vals = [g].flat(); ands.push(vals.length > 1 ? `facets:(${vals.join(" OR ")})` : `facets:${vals[0]}`); }
  }
  return nots.reduce((acc, n) => `(${acc}) NOT ${n}`, ands.join(" AND ")); // FTS5 NOT is binary: (a AND b) NOT c
}

export class Store {
  constructor(file = process.env.GOVAI_DB || "./data/govai.db") {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = this.db = new DatabaseSync(file);
    if (file !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
    db.exec(`PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=30000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-262144; PRAGMA mmap_size=1073741824;
      CREATE TABLE IF NOT EXISTS chunks (
        rowid INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, jur TEXT NOT NULL, kind TEXT NOT NULL, doc TEXT, meeting_date TEXT, date TEXT,
        part INTEGER, title TEXT, url TEXT, text TEXT, meta TEXT, hash TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_kind_jur ON chunks(kind, jur);
      CREATE INDEX IF NOT EXISTS chunks_news_date ON chunks(date) WHERE kind='news';
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(body, facets, content='', contentless_delete=1, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);`);
    db.exec("INSERT INTO chunk_fts(chunk_fts, rank) VALUES('rank', 'bm25(1.0, 0.0)')");
    this.q = {
      hash: db.prepare("SELECT rowid, hash FROM chunks WHERE key = ?"),
      up: db.prepare(`INSERT INTO chunks(key, jur, kind, doc, meeting_date, date, part, title, url, text, meta, hash, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET jur=excluded.jur, kind=excluded.kind, doc=excluded.doc, meeting_date=excluded.meeting_date, date=excluded.date, part=excluded.part,
        title=excluded.title, url=excluded.url, text=excluded.text, meta=excluded.meta, hash=excluded.hash, updated_at=excluded.updated_at RETURNING rowid`),
      delFts: db.prepare("DELETE FROM chunk_fts WHERE rowid = ?"),
      insFts: db.prepare("INSERT INTO chunk_fts(rowid, body, facets) VALUES(?,?,?)"),
      count: db.prepare("SELECT count(*) n FROM chunks"),
    };
  }
  static facetsOf(d) {
    return [facet("jur", d.jur), facet("kind", d.kind), d.doc && facet("doc", d.doc), d.meeting_date && facet("year", d.meeting_date.slice(0, 4))].filter(Boolean).join(" ");
  }
  /** Upsert docs; returns how many keys were new. Unchanged docs (same content hash) cost one SELECT. */
  addDocs(docs) {
    let added = 0, n = 0; const now = Date.now();
    this.db.exec("BEGIN");
    try {
      for (const d of docs) {
        if (++n % 1000 === 0) { this.db.exec("COMMIT"); this.db.exec("BEGIN"); } // short transactions: a dev server, warm.js and tests can share the file
        if (!d.jur) throw new Error(`doc without jur: ${d.title ?? d.url}`);
        const key = keyOf(d), body = normalize(d.searchText ?? `${d.title ?? ""} ${d.text ?? ""}`), facets = Store.facetsOf(d);
        const hash = crypto.createHash("sha1").update(body).update("\0").update(facets).update("\0").update(d.title ?? "").update("\0").update(d.url ?? "").update("\0").update(d.text ?? "").digest("hex");
        const prev = this.q.hash.get(key);
        if (prev?.hash === hash) continue;
        const meta = {}; for (const [k, v] of Object.entries(d)) if (!CORE.has(k) && v !== undefined) meta[k] = v;
        const { rowid } = this.q.up.get(key, d.jur, d.kind, d.doc ?? null, d.meeting_date ?? null, d.date ?? null, d.part ?? null, d.title ?? null, d.url ?? null, d.text ?? null, JSON.stringify(meta), hash, now);
        if (prev) this.q.delFts.run(rowid); else added++;
        this.q.insFts.run(rowid, body, facets);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return added;
  }
  /**
   * Ranked search. opts: { k, jurs: [ids] | null (all), kinds: [..], notKinds: [..] (SQL side), doc, notDoc, year, since (news date >=) }.
   * Rows carry score (= -bm25, same order of magnitude as the old index) and every stored field; never searchText.
   */
  search(query, { k = 5, jurs = null, kinds = null, notKinds = null, doc = null, notDoc = null, year = null, since = null } = {}) {
    const match = ftsQuery(query, [
      jurs && jurs.map((j) => facet("jur", j)), kinds && kinds.map((x) => facet("kind", x)),
      doc && facet("doc", doc), notDoc && { not: facet("doc", notDoc) }, year && facet("year", year),
    ]);
    if (!match) return [];
    const where = ["chunk_fts MATCH ?"], args = [match];
    if (notKinds?.length) { where.push(`c.kind NOT IN (${notKinds.map(() => "?").join(",")})`); args.push(...notKinds); }
    if (since) { where.push("c.date >= ?"); args.push(since); }
    args.push(k);
    const rows = this.db.prepare(`SELECT c.*, -chunk_fts.rank AS score FROM chunk_fts JOIN chunks c ON c.rowid = chunk_fts.rowid WHERE ${where.join(" AND ")} ORDER BY chunk_fts.rank LIMIT ?`).all(...args);
    return rows.map(({ rowid, key, meta, hash, updated_at, score, ...r }) => {
      const out = { score: +score.toFixed(2) };
      for (const [kk, v] of Object.entries(r)) if (v !== null) out[kk] = v;
      return Object.assign(out, JSON.parse(meta));
    });
  }
  count() { return this.q.count.get().n; }
  optimize() { this.db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')"); }
  close() { this.db.close(); }
}
