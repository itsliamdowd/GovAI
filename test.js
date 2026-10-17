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
console.log(`ok (${rag.datasetCount} datasets indexed)`);
process.exit(0);
