// Fixture tests for the agenda-platform adapters (no network). Run: node test-adapters.js  (also part of npm test)
import assert from "node:assert/strict";
import fs from "node:fs";
const F = "./adapters/fixtures/";
const read = (f) => fs.readFileSync(F + f, "utf8");
const { toYmd, html2text, absUrl } = await import("./adapters/_http.js");
const primegov = await import("./adapters/primegov.js");
const granicus = await import("./adapters/granicus.js");
const civicplus = await import("./adapters/civicplus.js");
const pdflist = await import("./adapters/pdflist.js");

// dates in every shape the portals use
assert.equal(toYmd("September 22, 2026"), "2026-09-22"); assert.equal(toYmd("Sep 22, 2026"), "2026-09-22"); assert.equal(toYmd("03/03/21"), "2021-03-03");
assert.equal(toYmd("2026-01-09T10:00:00"), "2026-01-09"); assert.equal(toYmd("_09222026-2793"), "2026-09-22"); assert.equal(toYmd("10-13-2026"), "2026-10-13"); assert.equal(toYmd("no date here"), null);
assert.equal(html2text("<p>a&amp;b</p><script>x</script><td>c</td>"), "a&b\nc");
assert.equal(absUrl("/AgendaCenter/ViewFile/Agenda/_1", "https://www.malibucity.org/x"), "https://www.malibucity.org/AgendaCenter/ViewFile/Agenda/_1");

// PrimeGov: LA City council meeting -> PDF agenda + HTML agenda + YouTube video; cancellation-only docs -> canceled
const J = { id: "los-angeles", council: { platform: "primegov", client: "lacity" } };
const pg = JSON.parse(read("primegov-lacity-sample.json")).map((m) => primegov.toRecord(m, J));
const council = pg.find((r) => r.body === "City Council Meeting");
assert.ok(council && council.id.startsWith("primegov-") && /^\d{4}-\d{2}-\d{2}$/.test(council.date), JSON.stringify(council));
assert.match(council.agenda_url, /^https:\/\/lacity\.primegov\.com\/Public\/CompiledDocument\?meetingTemplateId=\d+&compileOutputType=1$/);
assert.match(council.agenda_html_url, /compileOutputType=3$/); assert.equal(council.canceled, false);
assert.ok(pg.some((r) => r.canceled), "a cancellation-notice-only meeting is marked canceled");
const upcoming = JSON.parse(read("primegov-lacity-upcoming.json")).map((m) => primegov.toRecord(m, J));
assert.ok(upcoming.length > 5 && upcoming.every((r) => r.date >= "2026-10-01"), "upcoming list parses");

// Granicus ViewPublisher table (LA City 2008-2021) and its RSS fallback
const G = { id: "los-angeles", council: { platform: "granicus", client: "lacity" } }, view = { id: 129, body: "City Council" };
const rows = granicus.parseView(read("granicus-lacity-view-sample.html"), G, view);
assert.ok(rows.length >= 1, "view rows"); const r0 = rows[0];
assert.deepEqual([r0.id, r0.date, r0.body], ["granicus-129-20580", "2021-03-03", "City Council"]);
assert.equal(r0.agenda_url, "http://clkrep.lacity.org/granicus/2021/03032021_cal.htm"); assert.equal(r0.minutes_url, "http://clkrep.lacity.org/granicus/2021/03032021_jou.html");
assert.match(r0.transcript_url, /TranscriptViewer\.php\?view_id=129&clip_id=20580/); assert.match(r0.mp4_url, /\.mp4$/); assert.match(r0.video_url, /MediaPlayer\.php\?view_id=129&clip_id=20580/);
const rss = granicus.parseRss(read("granicus-lacity-rss-sample.xml"), G, view);
assert.equal(rss.length, 2); assert.equal(rss[0].date, "2021-03-03"); assert.match(rss[0].agenda_url, /AgendaViewer\.php\?view_id=129&clip_id=20580/);

// CivicPlus AgendaCenter: categories from the index page, rows from a category/year fragment
const cats = civicplus.parseCategories(read("civicplus-malibu-index-sample.html"));
assert.ok(cats.some((c) => c.name === "City Council" && c.id === 8), JSON.stringify(cats.slice(0, 3)));
const cp = civicplus.parseRows(read("civicplus-malibu-sample.html"), { id: 8, name: "City Council" }, "https://www.malibucity.org");
assert.ok(cp.length >= 2); assert.match(cp[0].id, /^civicplus-8-\d{8}-\d+$/); assert.match(cp[0].date, /^2025-\d{2}-\d{2}$/);
assert.match(cp[0].agenda_url, /^https:\/\/www\.malibucity\.org\/AgendaCenter\/ViewFile\/Agenda\/_\d{8}-\d+$/); assert.ok(cp[0].name.length > 8 && !/^pdf$/i.test(cp[0].name), `row title, got ${cp[0].name}`);
assert.ok(cp.some((r) => r.minutes_url.includes("/ViewFile/Minutes/")), "a row with minutes");

// pdflist: dated agenda + minutes links on one page collapse into one meeting record
const page = { url: "https://www.example.gov/clerk/agendas", body: "City Council" }, P = { id: "x", council: { platform: "pdflist", since: "2020" } };
const pl = pdflist.parseLinks(`<a href="/docs/CC-Agenda-10-13-2026.pdf">Agenda October 13, 2026</a> <a href="/docs/cc_minutes_10132026.pdf">Minutes - October 13, 2026</a>
  <a href="/docs/agenda-2019.pdf">Agenda January 5, 2019</a> <a href="/about">About us</a>`, page, P);
assert.equal(pl.length, 1); assert.equal(pl[0].date, "2026-10-13"); assert.equal(pl[0].agenda_url, "https://www.example.gov/docs/CC-Agenda-10-13-2026.pdf"); assert.match(pl[0].minutes_url, /minutes/);

// transcripts: multi-body channels keep one video per (date, body) and title the chunks by body
const T = await import("./transcripts.js");
assert.equal(T.bodyOf("Budget and Finance Committee - October 14, 2026 (with captions)"), "Budget and Finance Committee");
assert.equal(T.bodyOf("Los Angeles City Council Meeting 10/14/26"), "Los Angeles City Council");
assert.equal(T.bodyOf("City Council Meeting February 10, 2026"), "City Council");
const tdocs = T.toDocs({ id: "abc", date: "2026-02-10", body: "Public Safety Committee", segments: [{ t: 0, text: "hello" }] }, 1500, { id: "los-angeles", council: { label: "City Council" } });
assert.match(tdocs[0].title, /^Public Safety Committee 2026-02-10 — transcript/); assert.equal(tdocs[0].jur, "los-angeles");
console.log("adapters ok");
