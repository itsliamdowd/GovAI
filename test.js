// Smallest checks: application store round-trip + RAG retrieval. Run: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.ANTHROPIC_API_KEY ||= "test"; // server.js builds a client at import; no API call is made here
const { buildIndex } = await import("./rag.js");
const { submitApplication, checkStatus } = await import("./server.js");

const app = submitApplication({
  type: "community_event_permit", applicant_name: "Test Resident", email: "t@example.com", phone: "310-555-0100",
  address: "1685 Main St", requested_date: "2026-11-01", summary: "Block party", details: "150 people, no alcohol",
});
assert.match(app.confirmation_number, /^SM-\d{6}$/);
assert.equal(app.status, "received");
assert.equal(checkStatus(app.confirmation_number.toLowerCase()).summary, "Block party");
const apps = JSON.parse(fs.readFileSync("./data/applications.json", "utf8"));
delete apps[app.confirmation_number];
fs.writeFileSync("./data/applications.json", JSON.stringify(apps, null, 2));

const rag = await buildIndex();
const hits = rag.search("how much is a residential parking permit");
assert.ok(hits.length > 0, "retrieval returned nothing");
assert.ok(hits.some((h) => h.kind === "knowledge" && /parking/i.test(h.text)), "knowledge chunk about parking not retrieved");
if (rag.datasetCount) assert.ok(rag.search("active business licenses").some((h) => h.kind === "dataset" && /business/i.test(h.title)), "dataset not retrieved");
const { toDocs } = await import("./council.js");
const docs = toDocs({ date: "2026-09-08", agenda_url: "a", minutes_url: "m", agenda_text: "CALL TO ORDER\n\nitem one", minutes_text: "x ".repeat(2000) });
assert.equal(docs.filter((d) => d.doc === "agenda").length, 1);
assert.ok(docs.filter((d) => d.doc === "minutes").length >= 2, "long minutes should split into chunks");
rag.addDocs(docs);
assert.equal(rag.searchCouncil("call to order", 3)[0]?.meeting_date, "2026-09-08");
assert.ok(rag.search("call to order").every((d) => d.kind !== "council_meeting"), "council docs must not leak into general search");
const T = await import("./transcripts.js");
assert.equal(T.dateFromTitle("Santa Monica City Council Meeting February 10, 2026 (with captions)"), "2026-02-10");
assert.equal(T.dateFromTitle("City Council Meeting Sept. 9, 2025"), "2025-09-09");
assert.equal(T.dateFromTitle("Santa Monica City Council October 28th, 2025"), "2025-10-28");
const segs = T.vttToSegments("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start\n \nHello<00:00:01.500><c> there</c>\n\n00:00:02.000 --> 00:00:03.000\nHello there\n \n\n00:00:03.000 --> 00:00:04.000\nHello there\nnext<c> line</c>\n");
assert.deepEqual(segs.map((s) => s.text), ["Hello there", "next line"], "VTT rolling cues should dedupe");
const tdocs = T.toDocs({ id: "abc", date: "2026-02-10", segments: Array.from({ length: 400 }, (_, i) => ({ t: i * 5, text: "word ".repeat(10) })) });
assert.ok(tdocs.length >= 2 && tdocs[0].url === "https://www.youtube.com/watch?v=abc&t=0s" && tdocs[1].url.includes("&t="), "transcript chunks carry timestamped links");
rag.addDocs(tdocs);
assert.ok(rag.searchCouncil("word", 8, "", "transcript").every((d) => d.doc === "transcript"));
assert.ok(rag.searchCouncil("call to order", 8, "", "minutes").every((d) => d.doc === "minutes"));
assert.deepEqual(T.citedMoments("see [this](https://www.youtube.com/watch?v=HgCGwBwrNP8&t=364s) and https://www.youtube.com/watch?v=HgCGwBwrNP8&amp;t=364s dup, plus https://www.youtube.com/watch?v=abc123xyz&t=10"), [{ videoId: "HgCGwBwrNP8", t: 364 }, { videoId: "abc123xyz", t: 10 }]);
assert.equal(T.clipWindow("../etc", 0), null);
console.log(`ok (${rag.datasetCount} datasets indexed)`);
process.exit(0);
