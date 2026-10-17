// Hyland OnBase "Agenda Online" portals: City of San Diego (sandiego.hylandcloud.com/211agendaonlinecouncil, 2015->).
// Verified 2026-10-17:
//   GET <base>/Meetings                                  -> search form; hidden MeetingTypeIDs lists every meeting type for the site
//   GET <base>/Meetings/Search?dropid=11&mtids=<ids>&dropsv=MM/DD/YYYY 00:00:00&dropev=MM/DD/YYYY 00:00:00
//        -> one HTML page per date range (no paging; a half-year of council = ~130 meetings); each meeting has
//           <a id="lnkMeetingAgenda_<id>" title="View Agenda for <name> <body> on M/D/YYYY h:mm:ss AM">, optional lnkMeetingSummary_<id>,
//           and (in HTML comments) the PDF links /Documents/Downloadfile/<file>.pdf?documentType=1|3&meetingId=<id>
//   GET <base>/Documents/ViewAgenda?meetingId=<id>&type=agenda&doctype=1|3  -> the "accessible view": plain HTML of the full agenda (1)
//        or the Results Summary with votes (3). ViewMeeting pages are JS shells and the Downloadfile links need a JS stream handshake,
//        so we read these HTML views. (Meetings/ViewMeetingAgenda returns only an item-title outline, whatever the type param.)
// j.council = { platform: "hyland", url: "https://<host>/<site>", since?: "2023", bodies?: [regex strings], label }
import { fetchHtml, html2text, toYmd } from "./_http.js";

const DEFAULT_TYPES = "101,103,106,105,107,108,109,110,113,129,130";
const base = (j) => j.council.url.replace(/\/$/, "");

export function parseSearch(html, j) {
  const out = new Map(), b = base(j);
  const pdfs = new Map(); // id -> { 1: agendaPdf, 3: summaryPdf }
  for (const m of html.matchAll(/href="(\/[^"]*\/Documents\/Download[Ff]ile\/[^"]+documentType=(\d)&amp;meetingId=(\d+))"/g)) { const e = pdfs.get(m[3]) ?? {}; e[m[2]] = new URL(m[1].replace(/&amp;/g, "&"), b).href; pdfs.set(m[3], e); }
  for (const m of html.matchAll(/<a[^>]*href="[^"]*ViewMeeting\?id=(\d+)&amp;doctype=1[^"]*"[^>]*title="View Agenda for ([^"]+?) on (\d{1,2}\/\d{1,2}\/\d{4}) (\d{1,2}:\d{2}):\d{2} ([AP]M)"/g)) {
    const [, id, nameBody, d, hm, ap] = m;
    const bodyM = nameBody.match(/\b(City Council|Housing Authority|Successor Agency|Redevelopment Agency|Public Facilities Financing Authority|Committee[\w ,&]*)\s*$/i);
    const body = bodyM ? bodyM[1].trim() : (j.council.label ?? "City Council"), name = nameBody.replace(/\s+\S.*$/, (s) => s).replace(new RegExp(`\\s*${body}\\s*$`, "i"), "").trim() || body;
    const hasSummary = new RegExp(`id="lnkMeetingSummary_${id}"`).test(html), p = pdfs.get(id) ?? {};
    out.set(id, {
      id: `hyland-${id}`, platform: "hyland", body, name, date: toYmd(d), time: `${hm} ${ap}`, canceled: /cancel/i.test(name),
      agenda_url: `${b}/Documents/ViewAgenda?meetingId=${id}&type=agenda&doctype=1`, minutes_url: hasSummary ? `${b}/Documents/ViewAgenda?meetingId=${id}&type=agenda&doctype=3` : "",
      agenda_pdf_url: p[1] ?? "", minutes_pdf_url: p[3] ?? "", packet_url: "", portal_url: `${b}/Meetings/ViewMeeting?id=${id}&doctype=1`,
    });
  }
  return [...out.values()];
}

export async function listMeetings(j) {
  const b = base(j), now = new Date(), sinceY = Number(j.council.since) || now.getFullYear() - 2;
  let types = DEFAULT_TYPES;
  try { types = (await fetchHtml(`${b}/Meetings`)).match(/id="MeetingTypeIDs"[^>]*value="([^"]+)"/)?.[1] ?? types; } catch {}
  const bodies = (j.council.bodies ?? []).map((re) => new RegExp(re, "i"));
  const all = new Map();
  // half-year windows, newest first; include six months ahead for scheduled meetings
  for (let y = now.getFullYear() + 1; y >= sinceY; y--) for (const [s, e] of [[`07/01/${y}`, `12/31/${y}`], [`01/01/${y}`, `06/30/${y}`]]) {
    if (new Date(s) > new Date(now.getTime() + 190 * 864e5)) continue;
    const q = new URLSearchParams({ dropid: "11", mtids: types, dropsv: `${s} 00:00:00`, dropev: `${e} 00:00:00` });
    try { for (const r of parseSearch(await fetchHtml(`${b}/Meetings/Search?${q}`), j)) all.set(r.id, r); }
    catch (err) { console.error(`hyland ${j.id} ${s}-${e}: ${err.message}`); }
  }
  return [...all.values()].filter((r) => r.date && (!bodies.length || bodies.some((re) => re.test(`${r.name} ${r.body}`))))
    .sort((a, b2) => (b2.date + b2.time).localeCompare(a.date + a.time));
}

const empty = (t) => !t || t.length < 80 || /Document unavailable|no document/i.test(t.slice(0, 200));
async function view(url) { try { const t = html2text(await fetchHtml(url)); return empty(t) ? "" : t; } catch { return ""; } }
/** Agenda and the "Results Summary" (what was voted) from the accessible HTML views. */
export async function meetingText(m) {
  return { agenda_text: m.agenda_url ? await view(m.agenda_url) : "", minutes_text: m.minutes_url ? await view(m.minutes_url) : "" };
}
