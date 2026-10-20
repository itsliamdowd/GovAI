// Granicus govAccess / OpenCities CMS meeting pages (Lakewood, Bell). Verified 2026-10-17.
// An index page (e.g. .../CC-Mtgs-Minutes-Videos or .../2025-26-Agendas-and-Minutes) links to one page per meeting whose link text
// carries the date ("September 08, 2026 Regular Meeting"); the meeting page lists the PDFs under /files/assets/... or /files/<guid>/...
// j.council = { platform: "opencities", pages: [{ url, body }], since?: "2019", label }
import { fetchHtml, fetchText, toYmd, absUrl } from "./_http.js";

const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
export function parseIndex(html, page) {
  // meeting pages sit under the index page (Lakewood …/CC-Mtgs-Minutes-Videos/Council-Meeting-09-08-2026) or beside it
  // (Bell …/Agendas-and-Minutes/2025-26-Agendas-and-Minutes lists …/Agendas-and-Minutes/October-14-2026-…), so match on the parent path + a date
  const out = new Map(), self = page.url.replace(/\/$/, ""), prefix = self.slice(0, self.lastIndexOf("/") + 1);
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absUrl(m[1], page.url); if (!url.startsWith(prefix) || url.replace(/\/$/, "") === self) continue;
    const label = text(m[2]), date = toYmd(label) || toYmd(url.split("/").pop().replace(/-/g, " ")); if (!date) continue;
    if (!out.has(url)) out.set(url, { id: `opencities-${String(page.body ?? "x").replace(/\W+/g, "").toLowerCase()}-${date}-${url.split("/").pop().slice(0, 40)}`, platform: "opencities", body: page.body, name: label, date, time: "", canceled: /cancel/i.test(label), agenda_url: "", minutes_url: "", packet_url: "", page_url: url });
  }
  return [...out.values()];
}
export function parseMeeting(html, rec) {
  const docs = []; // every PDF on the page, classified by file name + link text
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+\.pdf[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absUrl(m[1], rec.page_url), blob = `${text(m[2])} ${decodeURIComponent(m[1].split("/").pop())}`; if (/spanish|espa/i.test(blob) || docs.some((d) => d.url === url)) continue;
    docs.push({ url, kind: /minute/i.test(blob) ? "minutes" : /agenda|index|consent|business|hearing|session|closed|packet/i.test(blob) ? "agenda" : "other" });
  }
  rec.minutes_url = docs.find((d) => d.kind === "minutes")?.url ?? ""; rec.agenda_urls = docs.filter((d) => d.kind === "agenda").map((d) => d.url); rec.agenda_url = rec.agenda_urls[0] ?? "";
  return rec;
}
export async function listMeetings(j) {
  const since = j.council.since ? `${j.council.since}-01-01` : "0", out = [];
  for (const page of j.council.pages ?? []) {
    let rows = []; try { rows = parseIndex(await fetchHtml(page.url), page).filter((r) => r.date >= since); } catch (e) { console.error(`opencities ${j.id} ${page.url}: ${e.message}`); }
    for (const r of rows) { try { out.push(parseMeeting(await fetchHtml(r.page_url), r)); } catch (e) { console.error(`opencities ${j.id} ${r.page_url}: ${e.message}`); } } // ponytail: one fetch per meeting, fine for the ~10-30 pages these sites keep
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
const txt = (u) => fetchText(u, { timeout: 120000 }).catch(() => "");
/** Agenda text = every agenda-part PDF on the page (Bell splits one agenda into index / consent / business / hearing files). */
export async function meetingText(m) {
  const parts = []; for (const u of m.agenda_urls?.length ? m.agenda_urls : [m.agenda_url].filter(Boolean)) parts.push(await txt(u));
  return { agenda_text: parts.filter(Boolean).join("\n\n"), minutes_text: m.minutes_url ? await txt(m.minutes_url) : "" };
}
