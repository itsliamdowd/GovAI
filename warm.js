// The ONLY place that collects data from the outside world. Run it on the maintainer's machine, commit data/,
// and every clone serves from the committed files. The server itself never collects unless COLLECT=1.
//   node warm.js            # everything
//   node warm.js council    # one collector: catalog | council | transcripts | gis | addresses | news
const { refreshCatalog } = await import("./rag.js");
const { ingestCouncil } = await import("./council.js");
const { ingestTranscripts } = await import("./transcripts.js");
const { loadGisCatalog, ingestNews, gisJurs, feedsFor } = await import("./sources.js");
const { SERVED, jurById } = await import("./jurisdictions.js");
//   node warm.js council irvine   # one collector for one jurisdiction id
const only = process.argv[2], jurs = process.argv[3] ? [jurById(process.argv[3])] : SERVED;
const want = (k) => !only || only === k;
const t0 = Date.now();
const jobs = [];
const log = (e) => console.error(e);
if (want("catalog")) jobs.push(refreshCatalog().then((d) => console.log(`catalog: ${d.length} datasets`)));
for (const j of jurs) {
  if (want("council") && j.council?.platform) jobs.push(ingestCouncil((docs, meta) => console.log(`council ${j.id}: ${meta.ingested.length} meetings, ${docs.length} chunks`), log, j));
  if (want("transcripts") && j.youtube?.length) jobs.push(ingestTranscripts((docs, videos) => console.log(`transcripts ${j.id}: ${videos.length} videos, ${docs.length} chunks`), log, j));
  if (want("news") && feedsFor(j).length) jobs.push(ingestNews((docs, meta) => console.log(`news ${j.id}: ${meta.fresh} new, ${meta.total} total`), log, j));
}
if (want("gis")) for (const j of gisJurs().filter((g) => jurs.includes(g))) jobs.push(loadGisCatalog(log, true, j).then((l) => console.log(`gis ${j.id}: ${l.length} layers`)));
if (want("addresses")) { const { ingestAddresses } = await import("./addresses.js"); for (const j of jurs) jobs.push(ingestAddresses(j, log)); } // needs each city's gis.json first
const results = await Promise.allSettled(jobs);
for (const r of results) if (r.status === "rejected") console.error("failed:", r.reason?.message ?? r.reason);
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
