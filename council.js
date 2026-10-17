// City Council meetings: agendas (IQM2 HTML) + official minutes (PDF) pulled via the
// "Agendas & Minutes" open dataset, cached to data/council/, chunked for retrieval.
// Minutes are the official record of what was said and decided; the Granicus video
// player exposes no caption/transcript file, so minutes stand in for transcripts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ckan, PORTALS } from "./rag.js";
import { jurById, dataDir, SERVED } from "./jurisdictions.js";

// Which jurisdiction's records: default Santa Monica (platform ckan-iqm2). Other platforms resolve to ./adapters/<platform>.js (legistar, granicus, primegov, civicplus, pdflist, hyland, ocboard, ...).
const SM = jurById("santa-monica");
const dirFor = (j) => `${dataDir(j)}/council`;
const limitFor = (j) => Number(process.env.COUNCIL_MEETINGS) || j.council?.limit || 200; // past meetings to ingest
const UA = { "User-Agent": "Mozilla/5.0 (GovAI civic assistant)" };
const run = promisify(execFile);

const html2text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
  .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#xa0;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

async function fetchText(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000), redirect: "follow" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

async function agendaText(url) {
  const t = html2text(await (await fetchText(url)).text());
  const i = t.indexOf("CALL TO ORDER");
  return i > 0 ? t.slice(i) : t;
}

// ponytail: shells out to poppler's pdftotext (brew install poppler); minutes are skipped if it's missing.
async function minutesText(url) {
  const buf = Buffer.from(await (await fetchText(url)).arrayBuffer());
  const tmp = path.join(os.tmpdir(), `sm-minutes-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    const { stdout } = await run("pdftotext", ["-layout", tmp, "-"], { maxBuffer: 50e6 });
    return stdout.replace(/[ \t]{2,}/g, "  ").replace(/\n{3,}/g, "\n\n").trim();
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Legistar Web API (no token for most clients): events for the configured body, newest first. ponytail: 1000/page, one page. */
async function legistarMeetings(j) {
  const { client, body } = j.council, base = `https://webapi.legistar.com/v1/${client}`;
  const r = await fetch(`${base}/events?${new URLSearchParams({ $orderby: "EventDate desc", $top: "1000", $filter: `startswith(EventBodyName, '${body}')` })}`, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${r.status} legistar ${client}`);
  return (await r.json()).map(legistarEvent);
}
export const legistarEvent = (e) => ({ id: `legistar-${e.EventId}`, event_id: e.EventId, body: e.EventBodyName, date: e.EventDate.slice(0, 10), time: e.EventTime ?? "", canceled: /cancel/i.test(e.EventComment ?? ""), agenda_url: e.EventAgendaFile || e.EventInSiteURL || "", minutes_url: e.EventMinutesFile || "", site_url: e.EventInSiteURL || "" });
/** Agenda items with their recorded actions ("ITEM 3 Title - Passed 4-1"): the decisions without reading the PDFs. */
async function legistarItemsText(j, event_id) {
  const r = await fetch(`https://webapi.legistar.com/v1/${j.council.client}/events/${event_id}/eventitems?AgendaNote=1&MinutesNote=1`, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!r.ok) return "";
  return (await r.json()).filter((i) => i.EventItemTitle).map((i) => [i.EventItemAgendaNumber && `${i.EventItemAgendaNumber}.`, i.EventItemTitle, i.EventItemActionName && ` -  Action: ${i.EventItemActionName}`, i.EventItemPassedFlagName && `(${i.EventItemPassedFlagName})`, i.EventItemMover && `Moved by ${i.EventItemMover}`, i.EventItemTally && `Vote: ${i.EventItemTally}`, i.EventItemMinutesNote].filter(Boolean).join(" ")).join("\n\n");
}
// Platform adapters. Built-ins live here; any other platform resolves to ./adapters/<platform>.js exporting
//   listMeetings(j) -> [{ id, date (YYYY-MM-DD), time, canceled, agenda_url, minutes_url, packet_url?, ...extra }]  (newest first)
//   meetingText?(m, j) -> { agenda_text, minutes_text }   (optional; default = fetch agenda_url/minutes_url as HTML or PDF)
const BUILTIN = { "ckan-iqm2": { listMeetings: ckanMeetings }, legistar: { listMeetings: legistarMeetings } };
async function adapterFor(j) {
  const platform = j.council?.platform; if (!platform) throw new Error(`no council platform configured for ${j.id}`);
  if (BUILTIN[platform]) return BUILTIN[platform];
  try { return await import(`./adapters/${platform}.js`); } catch (e) { throw new Error(`council platform ${platform} not supported yet for ${j.id} (${e.message})`); }
}
export async function listMeetings(j = SM) { return (await adapterFor(j)).listMeetings(j); }
async function ckanMeetings(j) {
  const { records } = await ckan("datastore_search", { resource_id: j.council.resource, filters: JSON.stringify({ agency_name: j.council.agency }), sort: "meeting_date desc", limit: 1000 }, PORTALS[j.council.portal].url);
  return records.map((r) => ({ id: r.id, date: r.meeting_date.slice(0, 10), time: r.meeting_date.slice(11, 16), canceled: !!r.is_canceled, agenda_url: r.agenda_url || "", minutes_url: r.minutes_url || "", packet_url: r.packet_url || "" }));
}

async function ingestMeeting(m, log, j = SM) {
  const file = `${dirFor(j)}/${m.id}.json`;
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  // re-fetch only if minutes have appeared since we last looked, or a past fetch left the agenda empty (404, bot wall, bad base URL) — at most 3 tries
  const tries = cached?.tries ?? 0, agendaMissing = m.agenda_url && !cached?.agenda_text && tries < 3;
  if (cached && (cached.minutes_text || !m.minutes_url) && !agendaMissing) return cached;
  const rec = { ...m, agenda_text: cached?.agenda_text ?? "", minutes_text: "", tries: tries + 1 };
  const custom = (await adapterFor(j)).meetingText;
  if (custom) { try { Object.assign(rec, await custom(m, j)); } catch (e) { log(`text ${m.date}: ${e.message}`); } fs.writeFileSync(file, JSON.stringify(rec)); return rec; }
  const isPdf = (u) => /\.pdf($|\?)|ViewReport\.ashx|legistar\.com\/View/i.test(u);
  if (!rec.agenda_text && m.agenda_url) { try { rec.agenda_text = isPdf(m.agenda_url) ? await minutesText(m.agenda_url) : await agendaText(m.agenda_url); } catch (e) { log(`agenda ${m.date}: ${e.message}`); } }
  if (m.minutes_url) { try { rec.minutes_text = await minutesText(m.minutes_url); } catch (e) { log(`minutes ${m.date}: ${e.message}`); } }
  if (j.council?.platform === "legistar" && m.event_id) { // items + actions are the searchable record of what was decided
    try { const items = await legistarItemsText(j, m.event_id); if (items) rec.minutes_text = (rec.minutes_text ? rec.minutes_text + "\n\n" : "") + "AGENDA ITEMS AND ACTIONS\n" + items; } catch (e) { log(`items ${m.date}: ${e.message}`); }
  }
  fs.writeFileSync(file, JSON.stringify(rec));
  return rec;
}

function chunk(text, size = 1500) {
  const out = []; let cur = "";
  for (const para of text.split(/\n\s*\n|\n(?=[A-Z0-9][A-Z0-9 .\-/&()]{6,}\n)/)) {
    if (cur.length + para.length > size && cur) { out.push(cur.trim()); cur = ""; }
    if (para.length > size) { // oversize paragraph: split on whitespace near the limit
      for (const piece of para.match(new RegExp(`[\\s\\S]{1,${size}}(?=\\s|$)`, "g")) ?? [para]) out.push(piece.trim());
      continue;
    }
    cur += para + "\n\n";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** "BOARD OF SUPERVISORS - LAND USE" with label "Board of Supervisors" -> "Board of Supervisors - Land Use"; shouting Legistar bodies get title case. */
export function bodyLabel(body, label = "City Council") {
  const b = (body ?? "").trim(); if (!b) return label || "City Council";
  if (label && b.toLowerCase().startsWith(label.toLowerCase())) return label + (b === b.toUpperCase() ? b.slice(label.length).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : b.slice(label.length));
  return b === b.toUpperCase() ? b.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : b;
}
export function toDocs(rec, j = SM) {
  const docs = [], label = bodyLabel(rec.body, j.council?.label); // multi-body platforms (LA City: 110 bodies) name the body per record
  for (const [type, text, url] of [["agenda", rec.agenda_text, rec.agenda_url], ["minutes", rec.minutes_text, rec.minutes_url]]) {
    if (!text) continue;
    chunk(text).forEach((t, i) => docs.push({
      kind: "council_meeting", jur: j.id, meeting_date: rec.date, doc: type, part: i + 1,
      title: `${label} ${rec.date} - ${type}`, url, text: t,
      searchText: `${label.toLowerCase()} meeting ${rec.date} ${type} ${t}`,
    }));
  }
  return docs;
}

/** Ingest recent council meetings; calls onDocs(docs, meetings) when done. Safe to run in the background. */
export async function ingestCouncil(onDocs, log = console.error, j = SM) {
  const DIR = dirFor(j);
  fs.mkdirSync(DIR, { recursive: true });
  const all = await listMeetings(j);
  const today = new Date().toISOString().slice(0, 10);
  const past = all.filter((m) => !m.canceled && m.date <= today && (m.agenda_url || m.minutes_url)).slice(0, limitFor(j));
  const upcoming = all.filter((m) => !m.canceled && m.date > today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  const docs = [];
  const queue = [...past];
  await Promise.all(Array.from({ length: 4 }, async () => { // 4 concurrent fetches
    for (let m; (m = queue.shift());) docs.push(...toDocs(await ingestMeeting(m, log, j), j));
  }));
  fs.writeFileSync(`${DIR}/meetings.json`, JSON.stringify({ fetched_at: Date.now(), ingested: past, upcoming }));
  onDocs(docs, { ingested: past, upcoming });
  return docs.length;
}

/** Offline: rebuild council docs from data/council/ only. No network. Empty if `node warm.js` has never run. */
export function loadCouncilCache(j = SM) {
  const DIR = dirFor(j);
  let meta = { ingested: [], upcoming: [] };
  try { meta = JSON.parse(fs.readFileSync(`${DIR}/meetings.json`, "utf8")); } catch {}
  const docs = [];
  if (meta.ingested.length) {
    for (const m of meta.ingested) { try { docs.push(...toDocs(JSON.parse(fs.readFileSync(`${DIR}/${m.id}.json`, "utf8")), j)); } catch {} }
  } else { // no meetings.json (older collector runs): every cached meeting file is the record
    let files = []; try { files = fs.readdirSync(DIR).filter((f) => /\.json$/.test(f) && f !== "meetings.json"); } catch {}
    const recs = files.flatMap((f) => { try { return [JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8"))]; } catch { return []; } })
      .filter((r) => r.date && (r.agenda_text || r.minutes_text)).sort((a, b) => b.date.localeCompare(a.date));
    for (const r of recs) docs.push(...toDocs(r, j));
    meta.ingested = recs.map(({ id, date, time, agenda_url, minutes_url }) => ({ id, date, time, agenda_url, minutes_url }));
  }
  return { docs, meta: { ingested: meta.ingested, upcoming: meta.upcoming } };
}
/** Every served jurisdiction that has council records on disk. */
export const councilJurs = () => SERVED.filter((j) => j.council && fs.existsSync(dirFor(j)));
