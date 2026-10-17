// Smallest checks: application store round-trip + RAG retrieval. Run: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
process.env.ANTHROPIC_API_KEY ||= "test"; // server.js builds a client at import; no API call is made here
const { buildIndex } = await import("./rag.js");
const { submitApplication, checkStatus, pertinentSources } = await import("./server.js");
const { FORMS, toApplication, formsFor } = await import("./forms.js");
const { JURS, SERVED, jurById, detect, scopeIds, nearest } = await import("./jurisdictions.js");

// Registry invariants + detection table (the jurisdiction is inferred from what the resident says).
assert.equal(new Set(JURS.map((j) => j.id)).size, JURS.length, "jurisdiction ids must be unique");
assert.ok(JURS.every((j) => !j.county || jurById(j.county)), "every county reference must exist");
assert.equal(SERVED.filter((j) => j.county === "san-diego-county").length, 18); assert.equal(SERVED.filter((j) => j.county === "orange-county").length, 34);
assert.ok(SERVED.some((j) => j.id === "san-diego-county") && SERVED.some((j) => j.id === "orange-county") && SERVED.some((j) => j.id === "santa-monica"));
for (const [text, want] of [["block party in Irvine", "irvine"], ["OC Board of Supervisors", "orange-county"], ["123 Main St, Chula Vista 91910", "chula-vista"], ["Orange County vs Irvine", null], ["city of orange trash", "orange"], ["orange cones", null], ["San Diego County assessor", "san-diego-county"], ["San Diego parking", "san-diego"], ["hello", null], ["I live in 90404", "santa-monica"], ["la jolla zoning", "san-diego"]])
  assert.equal(detect(text), want, `detect(${JSON.stringify(text)})`);
assert.deepEqual(scopeIds(jurById("irvine")), ["irvine", "orange-county", "california"]);
assert.equal(nearest(-118.49, 34.02)?.id, "santa-monica"); assert.equal(nearest(-117.16, 32.72)?.id, "san-diego");
assert.deepEqual(formsFor("santa-monica").sort(), Object.keys(FORMS).sort()); assert.deepEqual(formsFor("irvine"), formsFor("santa-monica")); // every jurisdiction gets every card (forms.js)

// Predefined forms: every field must be renderable, contact fields present, validation + mapping work.
for (const [type, f] of Object.entries(FORMS)) {
  assert.ok(f.title && f.intro && f.jur && f.source.startsWith(jurById(f.jur).site + "/"), `${type} needs title/intro and a source on its own jurisdiction's site`);
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
assert.match(app.confirmation_number, /^SM-\d{6}$/); assert.equal(app.jur, "santa-monica");
const irv = submitApplication({ type: "other", applicant_name: "T", email: "t@example.com", phone: "1", address: "", requested_date: "", summary: "s", details: "" }, jurById("irvine"));
assert.match(irv.confirmation_number, /^IRV-\d{6}$/); assert.equal(irv.jur, "irvine"); assert.match(irv.department, /Irvine/);
assert.equal(app.status, "received");
assert.equal(checkStatus(app.confirmation_number.toLowerCase()).summary, "Block party");
const apps = JSON.parse(fs.readFileSync("./data/applications.json", "utf8"));
delete apps[app.confirmation_number]; delete apps[irv.confirmation_number];
fs.writeFileSync("./data/applications.json", JSON.stringify(apps, null, 2));

const rag = await buildIndex();
const hits = rag.search("how much is a residential parking permit", 6, "santa-monica"); // Santa Monica scope: the index now holds other cities too
assert.ok(hits.length > 0, "retrieval returned nothing");
assert.ok(hits.filter((h) => h.kind === "knowledge").every((h) => /^https:\/\//.test(h.url) && !/^Source:/m.test(h.text)), "every knowledge chunk carries its section's Source url (and the line is stripped from text)");
// Sources shown to residents: block-party question must cite only the block party page, not tail hits like Water Usage / Street Sweeping.
const bpSrc = pertinentSources(rag.search("I want to host a block party on my street. What permit do I need and can you help me apply?", 6, "santa-monica"));
assert.deepEqual(bpSrc.map((s) => s.url), ["https://www.santamonica.gov/process-explainers/how-to-get-a-block-party-permit"], JSON.stringify(bpSrc));
assert.deepEqual(pertinentSources([]), []);
assert.deepEqual(pertinentSources([{ kind: "dataset", score: 9, url: "x" }, { kind: "knowledge", score: 9, url: "" }]), [], "datasets and url-less chunks never appear as sources");
assert.ok(hits.some((h) => h.kind === "knowledge" && /parking/i.test(h.text)), "knowledge chunk about parking not retrieved");
if (rag.datasetCount) assert.ok(rag.search("active business licenses", 6, "santa-monica").some((h) => h.kind === "dataset" && /business/i.test(h.title)), "dataset not retrieved");
const { toDocs } = await import("./council.js");
const docs = toDocs({ date: "2026-09-08", agenda_url: "a", minutes_url: "m", agenda_text: "CALL TO ORDER\n\nitem one", minutes_text: "x ".repeat(2000) });
assert.equal(docs.filter((d) => d.doc === "agenda").length, 1);
assert.ok(docs.filter((d) => d.doc === "minutes").length >= 2, "long minutes should split into chunks");
assert.equal(rag.addDocs(docs), docs.length, "addDocs returns how many were new");
assert.equal(rag.addDocs(docs), 0, "re-adding the same url#part must be a no-op");
assert.equal(rag.searchCouncil("call to order", 3)[0]?.meeting_date, "2026-09-08");
assert.ok(rag.search("call to order") === rag.search("call to order"), "identical queries are served from the result cache");
assert.ok(rag.search("call to order").every((d) => d.kind !== "council_meeting"), "council docs must not leak into general search");
// Scoping: a doc tagged for another jurisdiction never surfaces in a scoped search
rag.addDocs([{ kind: "knowledge", jur: "irvine", title: "Irvine trash", url: "https://www.cityofirvine.org/trash", part: 1, text: "irvine trash pickup is weekly on wednesdays", searchText: "irvine trash pickup is weekly on wednesdays" }]);
assert.ok(rag.search("trash pickup wednesdays", 6, "irvine").some((d) => d.jur === "irvine"), "scoped search must see its own jurisdiction");
assert.ok(rag.search("trash pickup wednesdays", 6, "santa-monica").every((d) => d.jur !== "irvine"), "scoped search must not see another city");
assert.ok(rag.search("trash pickup wednesdays", 6, null).some((d) => d.jur === "irvine"), "unscoped search sees everything");
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
// Phase B adapters: DCAT catalogs (City of San Diego inventory, Socrata/SANDAG, ArcGIS Hub), Legistar events, CSV files.
const R = await import("./rag.js");
const dc = R.dcatDatasets([
  { identifier: "accounts_city_budget", title: "Accounts in the City's annual budget", description: "<p>Budget accounts</p>", keyword: ["budget"], modified: "2026-07-01T00:00:00", publisher: { name: "Department of Finance" }, distribution: [{ title: "Accounts hierarchy", downloadURL: "https://seshat.datasd.org/accounts_city_budget/budget_reference_accounts_datasd.csv", mediaType: "text/csv", format: "csv" }, { title: "Shapefile", downloadURL: "https://x/y.zip", format: "shp" }] },
  { identifier: "https://opendata.sandag.org/api/views/228k-ku7f", title: "Broadband Cost", landingPage: "https://opendata.sandag.org/d/228k-ku7f", distribution: [{ downloadURL: "https://opendata.sandag.org/api/v3/views/228k-ku7f/export.csv", mediaType: "text/csv" }] },
  { identifier: "zoning", title: "Zoning", distribution: [{ accessURL: "https://services.arcgis.com/abc/arcgis/rest/services/Zoning/FeatureServer/0", format: "ArcGIS GeoServices REST API" }] },
  { identifier: "nothing", title: "No usable files", distribution: [{ downloadURL: "https://x/a.zip", format: "zip" }] },
], { site: "https://data.sandiego.gov", datasetUrl: "https://data.sandiego.gov/datasets/" });
assert.equal(dc.length, 3, "datasets without a queryable distribution are dropped");
assert.equal(dc[0].url, "https://data.sandiego.gov/datasets/accounts_city_budget/"); assert.equal(dc[0].org, "Department of Finance"); assert.equal(dc[0].notes, " Budget accounts ");
assert.deepEqual(dc[0].resources.map((r) => r.access.type), ["file"], "zip distributions are not queryable");
assert.deepEqual(dc[1].resources[0], { resource_id: "228k-ku7f", name: "Broadband Cost", format: "soda", datastore: true, access: { type: "soda", url: "https://opendata.sandag.org/resource/228k-ku7f.json" }, fields: [] }, "Socrata ids come from the identifier");
assert.equal(dc[2].resources[0].access.type, "arcgis");
assert.deepEqual(R.parseCsv('a,b\n1,"x, y"\n2,"he said ""hi"""\n'), [{ a: "1", b: "x, y" }, { a: "2", b: 'he said "hi"' }]);
const C = await import("./council.js");
const ev = C.legistarEvent({ EventId: 2040, EventBodyName: "BOARD OF SUPERVISORS", EventDate: "2026-10-07T00:00:00", EventTime: "9:00 AM", EventAgendaFile: "https://sdcounty.legistar.com/View.ashx?M=A&ID=1", EventMinutesFile: null, EventInSiteURL: "https://sdcounty.legistar.com/MeetingDetail.aspx?ID=2040", EventComment: "" });
assert.deepEqual(ev, { id: "legistar-2040", event_id: 2040, body: "BOARD OF SUPERVISORS", date: "2026-10-07", time: "9:00 AM", canceled: false, agenda_url: "https://sdcounty.legistar.com/View.ashx?M=A&ID=1", minutes_url: "", site_url: "https://sdcounty.legistar.com/MeetingDetail.aspx?ID=2040" });
assert.ok(C.toDocs({ date: "2026-10-07", agenda_url: "a", minutes_url: "m", agenda_text: "", minutes_text: "AGENDA ITEMS AND ACTIONS\n1. Airport lease - Action: Adopted (Pass) Vote: 4-1" }, jurById("san-diego-county")).every((d) => d.jur === "san-diego-county" && /^Board of Supervisors 2026-10-07/.test(d.title)));
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
const n1 = { kind: "news", jur: "santa-monica", title: "Pier closed", url: "https://smdp.com/pier", date: new Date().toISOString().slice(0, 10), publisher: "SMDP", text: "pier closed for repairs", searchText: "SMDP pier closed pier closed for repairs" };
rag.addDocs([n1]); rag.addDocs([{ ...n1 }]);
assert.equal(rag.searchNews("pier repairs").length, 1, "news re-ingest must not duplicate");
assert.ok(rag.search("pier repairs").some((d) => d.kind === "news"), "recent news should ride along in general search");
assert.ok(rag.searchNews("pier repairs", 10, 1).length === 1 && rag.searchNews("pier repairs", 10, 0).length === 1);
await assert.rejects(S.queryGis({ service_url: "https://evil.example/FeatureServer/0" }), /service_url/);
const ADDR = await import("./addresses.js");
if (ADDR.loadAddresses()) {
  const top = ADDR.suggestAddresses("1685 ma", 3);
  assert.equal(top[0]?.address, "1685 Main St", "building itself should come before its units");
  assert.ok(ADDR.suggestAddresses("ocean park bl", 5).every((a) => /Ocean Park Blvd/.test(a.address)));
  assert.deepEqual(ADDR.suggestAddresses("1"), [], "too-short queries return nothing");
}
const { speechText } = await import("./tts.js");
assert.equal(speechText("Call (310) 458-8411, Mon–Thu 7:30 a.m.–5:30 p.m. Confirmation SM-749311."), "Call 3 1 0, 4 5 8, 8 4 1 1, Monday through Thursday 7:30 AM to 5:30 PM. Confirmation S M, 7 4 9 3 1 1.");
assert.equal(speechText("601 Santa Monica Blvd; email 311@santamonica.gov or https://www.santamonica.gov/311."), "601 Santa Monica Boulevard; email 311 at santamonica dot gov or santamonica dot gov");
assert.equal(speechText("**Fee:** $100.95 & a 14–30 day notice. St. John is on 4th St / PCH, open 24/7. Zone 2 runs Jul 1–Jun 30."), "Fee: $100.95 and a 14 to 30 day notice. St. John is on 4th Street or Pacific Coast Highway, open twenty-four seven. Zone 2 runs July 1 to June 30.");
{ // cancel flow on the store: only undecided applications can be withdrawn
  const { submitApplication, checkStatus } = await import("./server.js");
  const a = submitApplication({ type: "dog_license", applicant_name: "T", email: "c@example.com", phone: "1", address: "", requested_date: "", summary: "cancel test", details: "" });
  const appsFile = JSON.parse(fs.readFileSync("./data/applications.json", "utf8"));
  assert.equal(appsFile[a.confirmation_number].status, "received");
  appsFile[a.confirmation_number].status = "canceled"; fs.writeFileSync("./data/applications.json", JSON.stringify(appsFile, null, 2));
  assert.equal(checkStatus(a.confirmation_number).status, "canceled");
  delete appsFile[a.confirmation_number]; fs.writeFileSync("./data/applications.json", JSON.stringify(appsFile, null, 2));
}
console.log(`ok (${rag.datasetCount} datasets indexed)`);
process.exit(0);
