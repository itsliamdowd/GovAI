// Orange County Board of Supervisors: board.oc.gov links to the agenda host https://ocagendaext.oc.gov (plain server-rendered HTML).
// Verified 2026-10-17:
//   GET https://ocagendaext.oc.gov/                    -> current-year table: <td>MM/DD/YYYY</td><td>h:mm AM</td><td> links "Agenda" (/ExtDocViewer/<guid>, PDF),
//                                                         "Agenda Items" (/MeetingItem/<guid>, HTML list of item numbers + titles), "Agenda Modifications", "Minutes" (PDF)
//   GET https://ocagendaext.oc.gov/ArchivedBosMeeting -> every meeting back to 2007 (~940 rows): <td>MM/DD/YYYY</td> + "Agenda"/"Minutes" (/LegacyDocViewer/<guid>, PDF)
//   /ExtDocViewer and /LegacyDocViewer serve application/pdf inline -> fetchText runs pdftotext.
// j.council = { platform: "ocboard", url: "https://board.oc.gov", agendas?: "https://ocagendaext.oc.gov", label: "Board of Supervisors", limit }
import { fetchHtml, fetchText, html2text, toYmd, absUrl } from "./_http.js";

const host = (j) => (j.council.agendas ?? "https://ocagendaext.oc.gov").replace(/\/$/, "");

export function parseTable(html, base) {
  const out = [];
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const d = tds[0]?.match(/\d{1,2}\/\d{1,2}\/\d{4}/)?.[0]; if (!d) continue;
    const time = tds.length > 2 ? tds[1].replace(/<[^>]+>/g, "").trim() : "";
    const links = {}; for (const a of row[1].matchAll(/<a[^>]*href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>/g)) links[a[2].toLowerCase()] = absUrl(a[1], base);
    const guid = (links.agenda ?? links.minutes ?? "").split("/").pop() || `${d}-${out.length}`;
    out.push({ id: `ocboard-${guid.toLowerCase()}`, platform: "ocboard", body: "Board of Supervisors", name: "Board of Supervisors", date: toYmd(d), time, canceled: false,
      agenda_url: links.agenda ?? "", minutes_url: links.minutes ?? "", items_url: links["agenda items"] ?? "", modifications_url: links["agenda modifications"] ?? "", packet_url: "", portal_url: base });
  }
  return out;
}

export async function listMeetings(j) {
  const b = host(j), all = new Map();
  for (const path of ["/", "/ArchivedBosMeeting"]) {
    try { for (const r of parseTable(await fetchHtml(`${b}${path}`), b)) if (!all.has(r.date + r.id)) all.set(r.date + r.id, r); }
    catch (err) { console.error(`ocboard ${j.id} ${path}: ${err.message}`); }
  }
  // the current-year table and the archive overlap for a few months; keep the richer (current) row per date+agenda guid
  return [...all.values()].sort((a, b2) => (b2.date + b2.time).localeCompare(a.date + a.time));
}

const txt = (url) => (url ? fetchText(url).then((t) => (t.length < 80 ? "" : t)).catch(() => "") : Promise.resolve(""));
/** Agenda = the "Agenda Items" HTML (clean item titles) when present, else the agenda PDF; minutes = Summary Action Minutes PDF. */
export async function meetingText(m) {
  let agenda = m.items_url ? await fetchHtml(m.items_url).then((h) => html2text(h.replace(/^[\s\S]*?<tbody>/, "").replace(/<\/tbody>[\s\S]*$/, "")).replace(/\bView\b\s*/g, "\n")).catch(() => "") : "";
  if (agenda.length < 80) agenda = await txt(m.agenda_url);
  return { agenda_text: agenda, minutes_text: await txt(m.minutes_url) };
}
