// Smallest checks: application store round-trip + RAG retrieval. Run: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.ANTHROPIC_API_KEY ||= "test"; // server.js builds a client at import; no API call is made here
const { buildIndex } = await import("./rag.js");
const { submitApplication, checkStatus, pertinentSources } = await import("./server.js");
const { FORMS, toApplication } = await import("./forms.js");

// Predefined forms: every field must be renderable, contact fields present, validation + mapping work.
for (const [type, f] of Object.entries(FORMS)) {
  assert.ok(f.title && f.intro && f.source.startsWith("https://www.santamonica.gov/"), `${type} needs title/intro/city source`);
  for (const fld of f.fields) { assert.ok(fld.key && fld.label, `${type} field missing key/label`); if (fld.type === "select") assert.ok(fld.options?.length, `${type}.${fld.key} select needs options`); }
  for (const k of ["applicant_name", "email", "phone"]) assert.ok(f.fields.some((x) => x.key === k), `${type} missing ${k}`);
  assert.throws(() => toApplication(type, {}), /required/, `${type} should reject empty answers`);
}
assert.throws(() => toApplication("nope", {}), /No form/);
const bp = toApplication("block_party_permit", { event_date: "2026-11-14", event_hours: "2–8 PM", street_block: "1100 block Euclid St", zoning: "Not sure", petition: "Already collected", expected_attendance: "60", address: "1120 Euclid St", applicant_name: "Test", email: "t@example.com", phone: "310-555-0100" });
assert.equal(bp.requested_date, "2026-11-14"); assert.equal(bp.address, "1120 Euclid St"); assert.match(bp.details, /Street and block to close: 1100 block Euclid St/); assert.ok(!/Your full name/.test(bp.details), "contact fields must not be duplicated into details");
assert.throws(() => toApplication("bulky_item_pickup", { address: "1 Main", items: "couch", placement: "Front curb", applicant_name: "T", email: "bad", phone: "1" }), /Email/);
const bulky = toApplication("bulky_item_pickup", { address: "1 Main", items: "couch", placement: "Front curb", applicant_name: "T", email: "t@example.com", phone: "1" }); // unit optional
assert.equal(bulky.type, "bulky_item_pickup");

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
assert.ok(hits.filter((h) => h.kind === "knowledge").every((h) => /^https:\/\//.test(h.url) && !/^Source:/m.test(h.text)), "every knowledge chunk carries its section's Source url (and the line is stripped from text)");
// Sources shown to residents: block-party question must cite only the block party page, not tail hits like Water Usage / Street Sweeping.
const bpSrc = pertinentSources(rag.search("I want to host a block party on my street. What permit do I need and can you help me apply?"));
assert.deepEqual(bpSrc.map((s) => s.url), ["https://www.santamonica.gov/process-explainers/how-to-get-a-block-party-permit"], JSON.stringify(bpSrc));
assert.deepEqual(pertinentSources([]), []);
assert.deepEqual(pertinentSources([{ kind: "dataset", score: 9, url: "x" }, { kind: "knowledge", score: 9, url: "" }]), [], "datasets and url-less chunks never appear as sources");
assert.ok(hits.some((h) => h.kind === "knowledge" && /parking/i.test(h.text)), "knowledge chunk about parking not retrieved");
if (rag.datasetCount) assert.ok(rag.search("active business licenses").some((h) => h.kind === "dataset" && /business/i.test(h.title)), "dataset not retrieved");
const { toDocs } = await import("./council.js");
const docs = toDocs({ date: "2026-09-08", agenda_url: "a", minutes_url: "m", agenda_text: "CALL TO ORDER\n\nitem one", minutes_text: "x ".repeat(2000) });
assert.equal(docs.filter((d) => d.doc === "agenda").length, 1);
assert.ok(docs.filter((d) => d.doc === "minutes").length >= 2, "long minutes should split into chunks");
assert.equal(rag.addDocs(docs), docs.length, "addDocs returns how many were new");
assert.equal(rag.addDocs(docs), 0, "re-adding the same url#part must be a no-op");
assert.equal(rag.searchCouncil("call to order", 3)[0]?.meeting_date, "2026-09-08");
assert.ok(rag.search("call to order") === rag.search("call to order"), "identical queries are served from the result cache");
assert.ok(rag.search("call to order").every((d) => d.kind !== "council_meeting"), "council docs must not leak into general search");
const T = await import("./transcripts.js");
assert.equal(T.dateFromTitle("Santa Monica City Council Meeting February 10, 2026 (with captions)"), "2026-02-10");
assert.equal(T.dateFromTitle("City Council Meeting Sept. 9, 2025"), "2025-09-09");
assert.equal(T.dateFromTitle("Santa Monica City Council October 28th, 2025"), "2025-10-28");
assert.equal(T.dateFromTitle("Santa Monica City Council Meeting June 11. 2019"), "2019-06-11");
assert.equal(T.dateFromTitle("City Council Meeting May 24 , 2016"), "2016-05-24");
assert.equal(T.dateFromTitle("Santa Monica City Council 7/22/14"), "2014-07-22");
const segs = T.vttToSegments("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start\n \nHello<00:00:01.500><c> there</c>\n\n00:00:02.000 --> 00:00:03.000\nHello there\n \n\n00:00:03.000 --> 00:00:04.000\nHello there\nnext<c> line</c>\n");
assert.deepEqual(segs.map((s) => s.text), ["Hello there", "next line"], "VTT rolling cues should dedupe");
const tdocs = T.toDocs({ id: "abc", date: "2026-02-10", segments: Array.from({ length: 400 }, (_, i) => ({ t: i * 5, text: "word ".repeat(10) })) });
assert.ok(tdocs.length >= 2 && tdocs[0].url === "https://www.youtube.com/watch?v=abc&t=0s" && tdocs[1].url.includes("&t="), "transcript chunks carry timestamped links");
rag.addDocs(tdocs);
assert.ok(rag.searchCouncil("word", 8, "", "transcript").every((d) => d.doc === "transcript"));
assert.ok(rag.searchCouncil("call to order", 8, "", "minutes").every((d) => d.doc === "minutes"));
assert.deepEqual(T.citedMoments("see [this](https://www.youtube.com/watch?v=HgCGwBwrNP8&t=364s) and https://www.youtube.com/watch?v=HgCGwBwrNP8&amp;t=364s dup, plus https://www.youtube.com/watch?v=abc123xyz&t=10"), [{ videoId: "HgCGwBwrNP8", t: 364 }, { videoId: "abc123xyz", t: 10 }]);
assert.equal(T.clipWindow("../etc", 0), null);
const A = await import("./alerts.js");
assert.deepEqual(A.diffEvidence(["a", "b"], [{ key: "a" }, { key: "c" }]).map((i) => i.key), ["c"], "diff should return only unseen keys");
const w = await A.createAlert(rag, { topic: "call to order", address: "1685 Main St", email: "t@example.com", name: "Test" });
assert.match(w.confirmation_number, /^WATCH-\d{6}$/);
assert.ok(w.seen.length > 0, "baseline evidence should be snapshotted so day 1 reports only new items");
assert.equal(A.cancelAlert(w.confirmation_number.toLowerCase()).status, "cancelled");
assert.ok(A.cancelAlert(w.confirmation_number).error, "cancelling twice should fail");
const S = await import("./sources.js");
const rss = S.parseFeed(`<rss><channel><item><title><![CDATA[Pier &amp; beach]]></title><link>https://www.bing.com/news/apiclick.aspx?ref=x&url=https%3A%2F%2Fsmdp.com%2Fa</link><pubDate>Fri, 17 Oct 2026 16:00:00 GMT</pubDate><description><![CDATA[<p>Body &#8217;s</p>]]></description><source url="x">Santa Monica Daily Press</source></item></channel></rss>`, { id: "t", name: "Feed" });
assert.deepEqual(rss, [{ title: "Pier & beach", url: "https://smdp.com/a", date: "2026-10-17", text: "Body 's", publisher: "Santa Monica Daily Press", feed: "t" }]);
const atom = S.parseFeed(`<feed><entry><title>Post</title><link rel="alternate" href="https://www.reddit.com/r/santamonica/p"/><updated>2026-10-16T01:00:00+00:00</updated><content type="html">&lt;b&gt;hi&lt;/b&gt;</content></entry></feed>`, { id: "reddit", name: "r/SantaMonica" });
assert.equal(atom[0].url, "https://www.reddit.com/r/santamonica/p"); assert.equal(atom[0].text, "hi"); assert.equal(atom[0].publisher, "r/SantaMonica");
assert.equal(S.parseFeed("<rss><item><title>Not SM</title><link>u</link></item></rss>", { filter: /santa monica/i }).length, 0, "feed filter should drop unrelated items");
// GTFS-RT FeedMessage{ entity#2 { id#1 "a", alert#5 { url#8 TS{ translation#1 { text#1 "u" } }, header#10 TS{...} } } }
const str = (f, s) => Buffer.concat([Buffer.from([(f << 3) | 2, Buffer.byteLength(s)]), Buffer.from(s)]);
const msg = (f, inner) => Buffer.concat([Buffer.from([(f << 3) | 2, inner.length]), inner]);
const ts = (f, s) => msg(f, msg(1, str(1, s)));
const feed = msg(2, Buffer.concat([str(1, "a"), msg(5, Buffer.concat([ts(8, "u"), ts(10, "Route 8 detour")]))]));
assert.deepEqual(S.gtfsAlerts(feed), [{ header: "Route 8 detour", description: "", url: "u", routes: [] }]);
assert.ok(S.isJunkLayer("Default 12") && S.isJunkLayer("Sewer Network Annotation") && !S.isJunkLayer("Preferential Parking") && !S.isJunkLayer("Zoning"));
const n1 = { kind: "news", title: "Pier closed", url: "https://smdp.com/pier", date: new Date().toISOString().slice(0, 10), publisher: "SMDP", text: "pier closed for repairs", searchText: "SMDP pier closed pier closed for repairs" };
rag.addDocs([n1]); rag.addDocs([{ ...n1 }]);
assert.equal(rag.searchNews("pier repairs").length, 1, "news re-ingest must not duplicate");
assert.ok(rag.search("pier repairs").some((d) => d.kind === "news"), "recent news should ride along in general search");
assert.ok(rag.searchNews("pier repairs", 10, 1).length === 1 && rag.searchNews("pier repairs", 10, 0).length === 1);
await assert.rejects(S.queryGis({ service_url: "https://evil.example/FeatureServer/0" }), /service_url/);
console.log(`ok (${rag.datasetCount} datasets indexed)`);
process.exit(0);
