// The ONLY place that collects data from the outside world. Run it on the maintainer's machine, commit data/,
// and every clone serves from the committed files. The server itself never collects unless COLLECT=1.
//   node warm.js            # everything
//   node warm.js council    # one collector: catalog | council | transcripts | gis | news
const { refreshCatalog } = await import("./rag.js");
const { ingestCouncil } = await import("./council.js");
const { ingestTranscripts } = await import("./transcripts.js");
const { loadGisCatalog, ingestNews } = await import("./sources.js");
const only = process.argv[2];
const want = (k) => !only || only === k;
const t0 = Date.now();
const jobs = [];
if (want("catalog")) jobs.push(refreshCatalog().then((d) => console.log(`catalog: ${d.length} datasets`)));
if (want("council")) jobs.push(ingestCouncil((docs, meta) => console.log(`council: ${meta.ingested.length} meetings, ${docs.length} chunks`)));
if (want("transcripts")) jobs.push(ingestTranscripts((docs, videos) => console.log(`transcripts: ${videos.length} videos, ${docs.length} chunks`)));
if (want("gis")) jobs.push(loadGisCatalog(console.error, true).then((l) => console.log(`gis: ${l.length} layers`)));
if (want("news")) jobs.push(ingestNews((docs, meta) => console.log(`news: ${meta.fresh} new, ${meta.total} total`)));
const results = await Promise.allSettled(jobs);
for (const r of results) if (r.status === "rejected") console.error("failed:", r.reason?.message ?? r.reason);
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
