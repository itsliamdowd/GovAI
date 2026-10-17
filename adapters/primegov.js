// PrimeGov (Granicus) public meeting portal: City of Los Angeles (lacity, ~110 bodies, 2016->), Long Beach (10/2023->).
// JSON API behind the portal, no auth (verified 2026-10-17):
//   GET https://<client>.primegov.com/api/v2/PublicPortal/ListArchivedMeetings?year=YYYY  -> [{id, title, dateTime, videoUrl, documentList:[{templateId, templateName, compileOutputType}]}]
//   GET https://<client>.primegov.com/api/v2/PublicPortal/ListUpcomingMeetings
//   document: https://<client>.primegov.com/Public/CompiledDocument?meetingTemplateId=<templateId>&compileOutputType=<1=PDF|3=HTML>
// j.council = { platform: "primegov", client, since?: "2016", bodies?: [regex strings] (default: every body), label }
import { fetchJson, fetchText, html2text, politeFetch, toYmd } from "./_http.js";

const base = (j) => `https://${j.council.client}.primegov.com`;
const docUrl = (j, d) => `${base(j)}/Public/CompiledDocument?meetingTemplateId=${d.templateId}&compileOutputType=${d.compileOutputType}`;
const isAgenda = (n) => /agenda|packet/i.test(n) && !/spanish|cancel|recess|sap video/i.test(n); // "Packet" = agenda + attachments where no Agenda template exists (Hawaiian Gardens)
const isMinutes = (n) => /journal|minutes|action summary|actions taken/i.test(n) && !/spanish/i.test(n);

export function toRecord(m, j) {
  const docs = m.documentList ?? [], name = (d) => (d.templateName ?? "").trim();
  const pick = (test, type) => docs.find((d) => test(name(d)) && d.compileOutputType === type && !/revised|supplemental|continuation/i.test(name(d))) ?? docs.find((d) => test(name(d)) && d.compileOutputType === type);
  const agendaPdf = pick(isAgenda, 1), agendaHtml = pick(isAgenda, 3), minutesPdf = pick(isMinutes, 1), minutesHtml = pick(isMinutes, 3);
  const canceled = /cancel/i.test(m.title) || (docs.length > 0 && docs.every((d) => /cancel|recess/i.test(name(d))));
  return {
    id: `primegov-${m.id}`, platform: "primegov", body: String(m.title ?? "").trim().replace(/\s+/g, " "), date: toYmd(m.dateTime) ?? toYmd(m.date), time: m.time ?? "", canceled,
    agenda_url: agendaPdf ? docUrl(j, agendaPdf) : agendaHtml ? docUrl(j, agendaHtml) : "", agenda_html_url: agendaHtml ? docUrl(j, agendaHtml) : "",
    minutes_url: minutesPdf ? docUrl(j, minutesPdf) : minutesHtml ? docUrl(j, minutesHtml) : "", minutes_html_url: minutesHtml ? docUrl(j, minutesHtml) : "",
    packet_url: "", video_url: m.videoUrl ?? "", portal_url: `${base(j)}/Portal/Meeting?meetingTemplateId=${(agendaHtml ?? agendaPdf ?? docs[0])?.templateId ?? ""}`,
  };
}

export async function listMeetings(j) {
  const now = new Date().getFullYear(), since = Number(j.council.since) || now - 1;
  const bodies = (j.council.bodies ?? []).map((b) => new RegExp(b, "i"));
  const raw = [];
  for (let y = now; y >= since; y--) { try { raw.push(...(await fetchJson(`${base(j)}/api/v2/PublicPortal/ListArchivedMeetings?year=${y}`))); } catch (e) { console.error(`primegov ${j.id} ${y}: ${e.message}`); } }
  try { raw.push(...(await fetchJson(`${base(j)}/api/v2/PublicPortal/ListUpcomingMeetings`))); } catch (e) { console.error(`primegov ${j.id} upcoming: ${e.message}`); }
  const seen = new Set();
  return raw.filter((m) => m?.id && !seen.has(m.id) && seen.add(m.id)).map((m) => toRecord(m, j))
    .filter((r) => r.date && (!bodies.length || bodies.some((re) => re.test(r.body))))
    .sort((a, b) => (b.date + (b.time ?? "")).localeCompare(a.date + (a.time ?? "")));
}

const gone = (t) => !t || /Document Not Found|no longer available/i.test(t.slice(0, 400));
async function htmlDoc(url) { const r = await politeFetch(url); if (!r.ok) return ""; const t = html2text(await r.text()); return gone(t) ? "" : t; }
/** Agenda: HTML rendition first (clean text), PDF fallback; minutes ("Journal" at LA City): PDF. */
export async function meetingText(m) {
  const out = { agenda_text: "", minutes_text: "" };
  if (m.agenda_html_url) out.agenda_text = await htmlDoc(m.agenda_html_url).catch(() => "");
  if (!out.agenda_text && m.agenda_url) out.agenda_text = await fetchText(m.agenda_url).then((t) => (gone(t) ? "" : t)).catch(() => "");
  if (m.minutes_url) out.minutes_text = await fetchText(m.minutes_url).then((t) => (gone(t) ? "" : t)).catch(() => "");
  return out;
}
