// CivicPlus / CivicEngage "AgendaCenter" (Malibu, El Monte, Inglewood, Alhambra, Avalon, La Verne, Paramount, Temple City…).
//   GET <site>/AgendaCenter                                      -> every category (body) with the current year's rows
//   GET <site>/AgendaCenter/UpdateCategoryList?catID=N&year=YYYY -> that body's rows for one year (HTML fragment; verified Malibu)
//   rows: <tr class="catAgendaRow"> ... <a href="/AgendaCenter/ViewFile/Agenda/_MMDDYYYY-ID">Title</a> ... ViewFile/Minutes/_MMDDYYYY-ID
// ViewFile returns a PDF with no extension, so meetingText goes through the content-sniffing fetchText.
// j.council = { platform: "civicplus", site?: j.site, since?: "2019", categories?: [names (regex) or ids to keep], label }
import { fetchHtml, fetchText, toYmd, absUrl } from "./_http.js";

const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
export function parseCategories(html) {
  const cats = [];
  for (const m of html.matchAll(/<h2[^>]*aria-controls="category-panel-(\d+)"[^>]*>([\s\S]*?)<\/h2>/gi)) cats.push({ id: +m[1], name: text(m[2]) });
  return cats;
}
export function parseRows(html, cat, site) {
  const out = [];
  for (const row of html.split(/<tr[^>]*class="catAgendaRow"[^>]*>/i).slice(1)) {
    const links = [...row.matchAll(/href="(\/AgendaCenter\/ViewFile\/Agenda\/(_\d{8}-\d+))"[^>]*>([\s\S]*?)<\/a>/gi)];
    const a = links.find((l) => !/^(pdf|html|download)$/i.test(text(l[3]))) ?? links[0]; if (!a) continue; // the row's title link, not its "PDF" download button
    const key = a[2], date = toYmd(key), title = text(a[3]);
    const minutes = row.match(/href="(\/AgendaCenter\/ViewFile\/Minutes\/_\d{8}-\d+)"/i)?.[1] ?? "";
    out.push({ id: `civicplus-${cat.id}-${key.slice(1)}`, platform: "civicplus", body: cat.name, name: title, date, time: "", canceled: /cancel/i.test(title),
      agenda_url: absUrl(a[1], site), minutes_url: minutes ? absUrl(minutes, site) : "", packet_url: "", category_id: cat.id });
  }
  return out;
}
export async function listMeetings(j) {
  const site = (j.council.site ?? j.site).replace(/\/$/, ""), now = new Date().getFullYear(), since = Number(j.council.since) || now - 1;
  const index = await fetchHtml(`${site}/AgendaCenter`);
  let cats = parseCategories(index);
  if (j.council.categories?.length) cats = cats.filter((c) => j.council.categories.some((k) => k === c.id || new RegExp(k, "i").test(c.name)));
  const out = [];
  for (const cat of cats) {
    const panel = index.split(`id="category-panel-${cat.id}"`)[1]?.split(/id="category-panel-\d+"/)[0] ?? "";
    out.push(...parseRows(panel, cat, site));
    for (let y = now - 1; y >= since; y--) { try { out.push(...parseRows(await fetchHtml(`${site}/AgendaCenter/UpdateCategoryList?catID=${cat.id}&year=${y}`), cat, site)); } catch (e) { console.error(`civicplus ${j.id} cat ${cat.id} ${y}: ${e.message}`); } }
  }
  const seen = new Set();
  return out.filter((r) => r.date && !seen.has(r.id) && seen.add(r.id)).sort((a, b) => b.date.localeCompare(a.date));
}
export async function meetingText(m) {
  const out = { agenda_text: "", minutes_text: "" };
  if (m.agenda_url) out.agenda_text = await fetchText(m.agenda_url).catch(() => "");
  if (m.minutes_url) out.minutes_text = await fetchText(m.minutes_url).catch(() => "");
  return out;
}
