// One-off cache warm-up: pulls every council meeting's agenda+minutes and every YouTube transcript into data/.
// The server does the same in the background on start; this just front-loads it. Run: node warm.js
const { ingestCouncil } = await import("./council.js");
const { ingestTranscripts } = await import("./transcripts.js");
const t0 = Date.now();
await Promise.all([
  ingestCouncil((docs, meta) => console.log(`council: ${meta.ingested.length} meetings, ${docs.length} chunks`)),
  ingestTranscripts((docs, videos) => console.log(`transcripts: ${videos.length} videos, ${docs.length} chunks`)),
]);
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
