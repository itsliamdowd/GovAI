// City Council meetings: agendas (IQM2 HTML) + official minutes (PDF) pulled via the
// "Agendas & Minutes" open dataset, cached to data/council/, chunked for retrieval.
// Minutes are the official record of what was said and decided; the Granicus video
// player exposes no caption/transcript file, so minutes stand in for transcripts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ckan } from "./rag.js";

const RESOURCE = "40013cb9-7b56-4059-a7eb-5de5a26f8bac"; // Agendas & Minutes datastore
const DIR = "./data/council";
const LIMIT = Number(process.env.COUNCIL_MEETINGS) || 1000; // past meetings to ingest (default: all, back to 2015)
const UA = { "User-Agent": "Mozilla/5.0 (SantaMonicaAssistant)" };
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

export async function listMeetings() {
  const { records } = await ckan("datastore_search", { resource_id: RESOURCE, filters: JSON.stringify({ agency_name: "City Council" }), sort: "meeting_date desc", limit: 1000 });
  return records.map((r) => ({ id: r.id, date: r.meeting_date.slice(0, 10), time: r.meeting_date.slice(11, 16), canceled: !!r.is_canceled, agenda_url: r.agenda_url || "", minutes_url: r.minutes_url || "", packet_url: r.packet_url || "" }));
}

async function ingestMeeting(m, log) {
  const file = `${DIR}/${m.id}.json`;
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  // re-fetch only if minutes have appeared since we last looked
  if (cached && (cached.minutes_text || !m.minutes_url)) return cached;
  const rec = { ...m, agenda_text: cached?.agenda_text ?? "", minutes_text: "" };
  if (!rec.agenda_text && m.agenda_url) { try { rec.agenda_text = await agendaText(m.agenda_url); } catch (e) { log(`agenda ${m.date}: ${e.message}`); } }
  if (m.minutes_url) { try { rec.minutes_text = await minutesText(m.minutes_url); } catch (e) { log(`minutes ${m.date}: ${e.message}`); } }
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

export function toDocs(rec) {
  const docs = [];
  for (const [type, text, url] of [["agenda", rec.agenda_text, rec.agenda_url], ["minutes", rec.minutes_text, rec.minutes_url]]) {
    if (!text) continue;
    chunk(text).forEach((t, i) => docs.push({
      kind: "council_meeting", meeting_date: rec.date, doc: type, part: i + 1,
      title: `City Council ${rec.date} — ${type}`, url, text: t,
      searchText: `city council meeting ${rec.date} ${type} ${t}`,
    }));
  }
  return docs;
}

/** Ingest recent council meetings; calls onDocs(docs, meetings) when done. Safe to run in the background. */
export async function ingestCouncil(onDocs, log = console.error) {
  fs.mkdirSync(DIR, { recursive: true });
  const all = await listMeetings();
  const today = new Date().toISOString().slice(0, 10);
  const past = all.filter((m) => !m.canceled && m.date <= today && m.agenda_url).slice(0, LIMIT);
  const upcoming = all.filter((m) => !m.canceled && m.date > today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  const docs = [];
  const queue = [...past];
  await Promise.all(Array.from({ length: 4 }, async () => { // 4 concurrent fetches
    for (let m; (m = queue.shift());) docs.push(...toDocs(await ingestMeeting(m, log)));
  }));
  fs.writeFileSync(`${DIR}/meetings.json`, JSON.stringify({ fetched_at: Date.now(), ingested: past, upcoming }));
  onDocs(docs, { ingested: past, upcoming });
  return docs.length;
}

/** Offline: rebuild council docs from data/council/ only. No network. Empty if `node warm.js` has never run. */
export function loadCouncilCache() {
  let meta = { ingested: [], upcoming: [] };
  try { meta = JSON.parse(fs.readFileSync(`${DIR}/meetings.json`, "utf8")); } catch {}
  const docs = [];
  if (meta.ingested.length) {
    for (const m of meta.ingested) { try { docs.push(...toDocs(JSON.parse(fs.readFileSync(`${DIR}/${m.id}.json`, "utf8")))); } catch {} }
  } else { // no meetings.json (older collector runs): every cached meeting file is the record
    let files = []; try { files = fs.readdirSync(DIR).filter((f) => /^city_council_\d+\.json$/.test(f)); } catch {}
    const recs = files.flatMap((f) => { try { return [JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8"))]; } catch { return []; } })
      .filter((r) => r.date && (r.agenda_text || r.minutes_text)).sort((a, b) => b.date.localeCompare(a.date));
    for (const r of recs) docs.push(...toDocs(r));
    meta.ingested = recs.map(({ id, date, time, agenda_url, minutes_url }) => ({ id, date, time, agenda_url, minutes_url }));
  }
  return { docs, meta: { ingested: meta.ingested, upcoming: meta.upcoming } };
}
