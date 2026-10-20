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
  const base = html.match(/<base\s[^>]*href=["']([^"']+)/i)?.[1] ?? page.url; // Arcadia: <base href="https://www.arcadiaca.gov/"> + "Document Center/…" links
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    // classify by link text + file name only: a folder called "Agenda and Minutes" in the path must not turn every agenda into minutes
    let file = m[1].split(/[?#]/)[0].split("/").pop(); try { file = decodeURIComponent(file); } catch {}
    let label = text(m[2]);
    // Revize sites (Arcadia) pair every document with a "Copy document link" button whose real title sits in data-copy-label / aria-label
    if (/copy .*link/i.test(label)) label = text(m[0].match(/data-copy-label="([^"]*)"/)?.[1] ?? m[0].match(/aria-label="Copy[^"]*? for ([^"]*)"/)?.[1] ?? label);
    // CivicPlus Archive Center (Huntington Park): the row links to Archive.aspx?ADID=N; the PDF itself is /ArchiveCenter/ViewFile/Item/N
    const url = absUrl(m[1].replace(/^(.*?)Archive\.aspx\?ADID=(\d+).*$/, "$1ArchiveCenter/ViewFile/Item/$2"), base), blob = `${label} ${file}`;
    if (!url || !keep.test(blob)) continue;
    let date = toYmd(label); if (!date) { try { date = toYmd(decodeURIComponent(m[1])); } catch { date = null; } }
    if (!date || date < since) continue;
    const key = `${page.body}|${date}`;
    const rec = by.get(key) ?? by.set(key, { id: `pdflist-${String(page.body ?? "x").replace(/\W+/g, "").toLowerCase()}-${date}`, platform: "pdflist", body: page.body, name: label, date, time: "", canceled: false, agenda_url: "", minutes_url: "", packet_url: "" }).get(key);
    if (/minute|action|summary/i.test(blob)) rec.minutes_url ||= url; else if (/packet/i.test(blob)) rec.packet_url ||= url; else rec.agenda_url ||= url;
    if (/cancel/i.test(blob)) rec.canceled = true;
  }
  for (const r of by.values()) r.agenda_url ||= r.packet_url; // packet-only sites (Arcadia): the packet is the agenda text
  return [...by.values()];
}
export async function listMeetings(j) {
  const out = [];
  for (const page of j.council.pages ?? []) { try { out.push(...parseLinks(await fetchHtml(page.url), page, j)); } catch (e) { console.error(`pdflist ${j.id} ${page.url}: ${e.message}`); } }
  // the same body+date can surface on several pages (Huntington Park keeps agendas and minutes in separate Archive Center modules): merge, don't duplicate
  const by = new Map(); for (const r of out) { const e = by.get(r.id); if (!e) by.set(r.id, r); else { e.agenda_url ||= r.agenda_url; e.minutes_url ||= r.minutes_url; e.packet_url ||= r.packet_url; e.canceled &&= r.canceled; } }
  return [...by.values()].sort((a, b) => b.date.localeCompare(a.date));
}
export async function meetingText(m) {
  const out = { agenda_text: "", minutes_text: "" };
  const big = { timeout: 240000 }; // Arcadia agenda packets run 30+ MB; the default 45 s aborts them
  if (m.agenda_url) out.agenda_text = await fetchText(m.agenda_url, big).catch(() => "");
  if (m.minutes_url) out.minutes_text = await fetchText(m.minutes_url, big).catch(() => "");
  return out;
}
