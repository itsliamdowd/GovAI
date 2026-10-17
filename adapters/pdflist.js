// Generic "page of links" adapter for the ~35 LA County cities and county commissions that post agendas/minutes as a
// plain HTML list of PDFs (Arcadia, Bellflower, Cerritos, Covina, Glendora, Lomita, Norwalk, San Marino, Parks Commission…).
// j.council = { platform: "pdflist", pages: [{ url, body }], link?: regex over "link text + href" to keep (default agenda|minutes|packet|summary),
//               since?: "2019", label }
// A record is one dated meeting per body: agenda link + minutes link grouped by date. Text extraction sniffs PDF vs HTML.
import { fetchHtml, fetchText, toYmd, absUrl } from "./_http.js";

const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
export function parseLinks(html, page, j) {
  const keep = new RegExp(j.council.link ?? "agenda|minutes|packet|summary", "i"), by = new Map();
  const since = j.council.since ? `${j.council.since}-01-01` : "0";
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absUrl(m[1], page.url), label = text(m[2]), blob = `${label} ${m[1]}`;
    if (!url || !keep.test(blob)) continue;
    let date = toYmd(label); if (!date) { try { date = toYmd(decodeURIComponent(m[1])); } catch { date = null; } }
    if (!date || date < since) continue;
    const key = `${page.body}|${date}`;
    const rec = by.get(key) ?? by.set(key, { id: `pdflist-${String(page.body ?? "x").replace(/\W+/g, "").toLowerCase()}-${date}`, platform: "pdflist", body: page.body, name: label, date, time: "", canceled: false, agenda_url: "", minutes_url: "", packet_url: "" }).get(key);
    if (/minute|action|summary/i.test(blob)) rec.minutes_url ||= url; else if (/packet/i.test(blob)) rec.packet_url ||= url; else rec.agenda_url ||= url;
    if (/cancel/i.test(blob)) rec.canceled = true;
  }
  return [...by.values()];
}
export async function listMeetings(j) {
  const out = [];
  for (const page of j.council.pages ?? []) { try { out.push(...parseLinks(await fetchHtml(page.url), page, j)); } catch (e) { console.error(`pdflist ${j.id} ${page.url}: ${e.message}`); } }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
export async function meetingText(m) {
  const out = { agenda_text: "", minutes_text: "" };
  if (m.agenda_url) out.agenda_text = await fetchText(m.agenda_url).catch(() => "");
  if (m.minutes_url) out.minutes_text = await fetchText(m.minutes_url).catch(() => "");
  return out;
}
