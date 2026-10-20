// City of Pasadena council agendas: https://ww2.cityofpasadena.net/?year=YYYY (classic ASP site, 2014->). Verified 2026-10-17.
// Each year page lists, per meeting, relative links like "../2026 Agendas/Jan_12_26/agenda.asp" (HTML agenda),
// "../2026 Agendas/CC MINUTES/2026 01 12 CC MIN.pdf" (minutes) and "../2026 Agendas/Jan_19_26/CANCELLATION NOTICE.pdf".
// j.council = { platform: "pasadena", url?: "https://ww2.cityofpasadena.net", since?: "2019", label }
import { fetchHtml, fetchText, html2text, absUrl } from "./_http.js";

const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12" };
export function parseYear(html, base, body) {
  const by = new Map(), get = (date) => by.get(date) ?? by.set(date, { id: `pasadena-${date}`, platform: "pasadena", body, name: `${body} Meeting`, date, time: "", canceled: false, agenda_url: "", minutes_url: "", packet_url: "" }).get(date);
  for (const m of html.matchAll(/href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].replace(/&amp;/g, "&"), label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); let dec = href; try { dec = decodeURIComponent(href); } catch {}
    const f = dec.match(/\/([A-Za-z]{3,4})_(\d{1,2})_(\d{2})\//); // folder Mon_DD_YY
    const mn = dec.match(/(\d{4})[ _-](\d{2})[ _-](\d{2})[^/]*\bCC\b[^/]*MIN/i); // minutes "2026 01 12 CC MIN.pdf"
    if (f && MON[f[1].toLowerCase()]) { const rec = get(`20${f[3]}-${MON[f[1].toLowerCase()]}-${f[2].padStart(2, "0")}`);
      if (/cancel/i.test(`${label} ${dec}`)) rec.canceled = true; else if (/agenda\.asp$/i.test(dec) && !rec.agenda_url) rec.agenda_url = absUrl(href, base); else if (/agenda/i.test(dec) && /\.pdf$/i.test(dec) && !rec.agenda_url) rec.agenda_url = absUrl(href, base); }
    else if (mn) get(`${mn[1]}-${mn[2]}-${mn[3]}`).minutes_url ||= absUrl(href, base);
  }
  return [...by.values()];
}
export async function listMeetings(j) {
  const base = (j.council.url ?? "https://ww2.cityofpasadena.net").replace(/\/$/, "") + "/", now = new Date().getFullYear(), since = Number(j.council.since) || now - 2, out = [];
  for (let y = now; y >= since; y--) { try { out.push(...parseYear(await fetchHtml(`${base}?year=${y}`), base, j.council.label ?? "City Council")); } catch (e) { console.error(`pasadena ${y}: ${e.message}`); } }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
const strip = (t) => t.replace(/^[\s\S]*?(CITY COUNCIL|AGENDA)/, "$1"); // drop site chrome before the agenda heading
export async function meetingText(m) {
  const agenda = m.agenda_url ? await fetchText(m.agenda_url, { timeout: 120000 }).then(strip).catch(() => "") : "";
  return { agenda_text: agenda, minutes_text: m.minutes_url ? await fetchText(m.minutes_url, { timeout: 120000 }).catch(() => "") : "" };
}
