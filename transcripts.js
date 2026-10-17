// City Council meeting transcripts from the City of Santa Monica YouTube channel captions.
// yt-dlp lists the channel and pulls the English caption track (manual if present, else YouTube's
// auto-captions); VTT is flattened to timestamped text, chunked, and indexed. Cached in data/transcripts/.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
// Every channel that has ever carried a council meeting (found by searching YouTube, 2026-10-17). Oldest on YouTube: July 8, 2014.
import { jurById, dataDir, SERVED } from "./jurisdictions.js";
const SM = jurById("santa-monica");
const dirFor = (j) => `${dataDir(j)}/transcripts`;
const channelsFor = (j) => (j.id === "santa-monica" && process.env.COUNCIL_YT_CHANNELS ? process.env.COUNCIL_YT_CHANNELS.split(",").map((c) => c.trim()).filter(Boolean) : j.youtube ?? []);
const CHANNELS = (process.env.COUNCIL_YT_CHANNELS ?? [
  "UC4V0jOEL4JMCcElkGA7AJpA", // City of Santa Monica: 2017 -> now (+ one 2014)
  "UC8x0GS29SP-IbeiLRxMNlaw", // City of Santa Monica Meeting Coverage: Nov 2015 -> Mar 2017
  "UCrlsaKRGJhbvnJbvRpQWykA", // SMUpdateCityTV16: July 2014
].join(",")).split(",").map((c) => c.trim()).filter(Boolean);
const COOKIES = process.env.YT_COOKIES_FROM_BROWSER ? ["--cookies-from-browser", process.env.YT_COOKIES_FROM_BROWSER] : []; // e.g. "chrome" if YouTube bot-checks the server's IP
const TABS = ["streams", "videos"]; // council meetings are livestreamed, so most live under /streams
const DIR = dirFor(SM); // default (Santa Monica); per-jurisdiction paths via dirFor(j)
const LIST_TTL_MS = 24 * 3600 * 1000;
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export function dateFromTitle(title) {
  const m = title.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*[,.]?\s+(\d{4})/) ?? title.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let y, mo, d;
  if (isNaN(m[1])) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; } else { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  if (!mo || !d || !y) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const ymd = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
/** Broadcast date of one video (livestream release date, else upload date), for titles with no date in them. */
async function uploadDate(id) {
  try { return ymd((await run("yt-dlp", ["--print", "%(release_date,upload_date)s", `https://www.youtube.com/watch?v=${id}`])).stdout.trim()); } catch { return null; }
}

export async function listVideos(log = console.error, j = SM) {
  const file = `${dirFor(j)}/videos.json`;
  const channels = channelsFor(j), key = channels.join();
  try { const c = JSON.parse(fs.readFileSync(file, "utf8")); if (c.key === key && Date.now() - c.fetched_at < LIST_TTL_MS) return c.videos; } catch {}
  let stdout = "";
  for (const ch of channels) for (const tab of TABS) {
    try { stdout += (await run("yt-dlp", ["--flat-playlist", "--print", "%(id)s\t%(title)s", `https://www.youtube.com/channel/${ch}/${tab}`], { maxBuffer: 50e6 })).stdout + "\n"; }
    catch (e) { log(`yt-dlp ${ch}/${tab}: ${e.stderr?.split("\n").find((l) => l.includes("ERROR")) ?? e.message}`); }
  }
  const isMeeting = (t) => (j.council?.titleRe ?? /council/i).test(t) && /meeting|city council\b|board of supervisors/i.test(t) && !/planning|rent control|candidate|forum|budget study|workshop|retreat|proclamation|covid|booster|mask|message|election|statement|squirm/i.test(t);
  const all = stdout.split("\n").map((l) => l.split("\t")).filter(([id, t]) => id && isMeeting(t))
    .map(([id, title]) => ({ id, title: title.trim(), date: dateFromTitle(title) }));
  for (const v of all) if (!v.date) v.date = await uploadDate(v.id); // e.g. "City Council Meeting" with no date in the title
  all.splice(0, all.length, ...all.filter((v) => v.date));
  // one video per meeting date: prefer the captioned upload, then anything that isn't a "Copy of"
  const rank = (v) => (/with captions/i.test(v.title) ? 2 : 0) + (/^copy of/i.test(v.title) ? 0 : 1);
  const byDate = new Map();
  for (const v of all) if (!byDate.has(v.date) || rank(v) > rank(byDate.get(v.date))) byDate.set(v.date, v);
  const videos = [...byDate.values()];
  fs.writeFileSync(file, JSON.stringify({ fetched_at: Date.now(), key, videos }, null, 1));
  log(`YouTube: ${videos.length} council meeting videos listed`);
  return videos;
}

/** VTT (incl. YouTube's rolling auto-caption cues) -> [{t: seconds, text}] with consecutive duplicates removed. */
export function vttToSegments(vtt) {
  const segs = []; let last = "";
  for (const block of vtt.split(/\n\n+/)) {
    const m = block.match(/(\d{2}):(\d{2}):(\d{2})\.\d{3} --> /); if (!m) continue;
    const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
    const lines = block.split("\n").slice(1).map((l) => l.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").trim()).filter(Boolean);
    for (const line of lines) { if (line !== last) { segs.push({ t, text: line }); last = line; } }
  }
  return segs;
}

async function fetchTranscript(v, log, j = SM) {
  const DIR = dirFor(j);
  const file = `${DIR}/${v.id}.json`;
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    // keep a captioned result forever; re-check an uncaptioned one weekly (captions can appear later, or the pull may have failed)
    if (c.segments.length || Date.now() - (c.checked_at ?? 0) < 7 * 86400e3) return c;
  } catch {}
  const out = `${DIR}/${v.id}`;
  let vttFile = null, failed = false;
  for (const lang of ["en", "en-orig"]) { // one track per call: asking for both races on the same .part file
    try {
      await run("yt-dlp", ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", lang, "--sub-format", "vtt", "--sleep-subtitles", "1", ...COOKIES, "-o", out, `https://www.youtube.com/watch?v=${v.id}`], { maxBuffer: 50e6 });
    } catch (e) { failed = true; log(`captions ${v.date} ${v.id}: ${e.stderr?.split("\n").find((l) => l.includes("ERROR")) ?? e.message}`); }
    if (fs.existsSync(`${out}.${lang}.vtt`)) { vttFile = `${out}.${lang}.vtt`; break; }
  }
  // a yt-dlp error (bot check, 429) is not "no captions": checked_at 0 makes the next run retry immediately instead of in a week
  const rec = { ...v, checked_at: failed && !vttFile ? 0 : Date.now(), segments: vttFile ? vttToSegments(fs.readFileSync(vttFile, "utf8")) : [] };
  for (const f of [`${out}.en.vtt`, `${out}.en-orig.vtt`, `${out}.en.vtt.part`, `${out}.en-orig.vtt.part`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(file, JSON.stringify(rec));
  return rec;
}

const hms = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function toDocs(rec, size = 1500, j = SM) {
  const docs = [], label = j.council?.label ?? "City Council"; let cur = "", start = null, part = 0;
  const flush = () => { if (cur.trim()) docs.push({
    kind: "council_meeting", jur: j.id, doc: "transcript", meeting_date: rec.date, part: ++part,
    title: `${label} ${rec.date} — transcript @${hms(start)}`, url: `https://www.youtube.com/watch?v=${rec.id}&t=${start}s`,
    text: cur.trim(), searchText: `${label.toLowerCase()} meeting ${rec.date} transcript ${cur}`,
  }); cur = ""; start = null; };
  for (const s of rec.segments) {
    if (start === null) start = s.t;
    cur += s.text + " ";
    if (cur.length >= size) flush();
  }
  flush();
  return docs;
}

/** Pull captions for every council meeting video; onDocs(docs, videos) when done. Background-safe. */
export async function ingestTranscripts(onDocs, log = console.error, j = SM) {
  fs.mkdirSync(dirFor(j), { recursive: true });
  const videos = await listVideos(log, j);
  const docs = [];
  const queue = [...videos].sort((a, b) => b.date.localeCompare(a.date)); // newest first
  await Promise.all(Array.from({ length: 2 }, async () => { // 2 concurrent; be polite to YouTube
    for (let v; (v = queue.shift());) docs.push(...toDocs(await fetchTranscript(v, log, j), 1500, j));
  }));
  onDocs(docs, videos);
  return docs.length;
}

/** Offline: rebuild transcript docs from data/transcripts/ only. No network, no yt-dlp. */
export function loadTranscriptCache(j = SM) {
  const DIR = dirFor(j);
  let videos = [];
  try { videos = JSON.parse(fs.readFileSync(`${DIR}/videos.json`, "utf8")).videos; } catch { return { docs: [], count: 0 }; }
  const docs = []; let count = 0;
  for (const v of videos) {
    try { const rec = JSON.parse(fs.readFileSync(`${DIR}/${v.id}.json`, "utf8")); if (rec.segments.length) { count++; docs.push(...toDocs(rec, 1500, j)); } } catch {}
  }
  return { docs, count };
}
export const transcriptJurs = () => SERVED.filter((j) => fs.existsSync(`${dirFor(j)}/videos.json`));

/** Transcript window around a cited moment, from the local cache. Returns null if that video isn't cached. */
export function clipWindow(videoId, t, before = 10, after = 90) {
  if (!/^[\w-]{6,20}$/.test(videoId)) return null;
  let rec; try { rec = JSON.parse(fs.readFileSync(`${DIR}/${videoId}.json`, "utf8")); } catch { // not Santa Monica: look in every jurisdiction's cache
    const f = SERVED.map((j) => `${dirFor(j)}/${videoId}.json`).find((x) => fs.existsSync(x)); if (!f) return null; rec = JSON.parse(fs.readFileSync(f, "utf8")); }
  const segs = rec.segments.filter((s) => s.t >= t - before && s.t <= t + after);
  return { id: `${videoId}-${t}`, video_id: videoId, t, hms: hms(t), meeting_date: rec.date, title: rec.title,
    url: `https://www.youtube.com/watch?v=${videoId}&t=${t}s`, embed: `https://www.youtube-nocookie.com/embed/${videoId}?start=${t}&autoplay=1`,
    text: segs.map((s) => s.text).join(" ").trim() };
}
/** Every YouTube link with a timestamp in a piece of text -> [{videoId, t}]. */
export function citedMoments(text) {
  const out = new Map();
  for (const m of text.matchAll(/youtube\.com\/watch\?v=([\w-]{6,20})(?:&(?:amp;)?[^\s)&]*)*?&(?:amp;)?t=(\d+)s?/g)) out.set(`${m[1]}-${m[2]}`, { videoId: m[1], t: +m[2] });
  return [...out.values()];
}
