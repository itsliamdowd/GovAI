// Granicus ViewPublisher archives (the classic "video + agenda + minutes" table): LA City 2008-2021 (view 129 council,
// 46 committees, transcripts via TranscriptViewer), Hermosa Beach, La Puente, Rancho Palos Verdes, Redondo Beach, Pasadena…
// Listing: https://<client>.granicus.com/ViewPublisher.php?view_id=N is a plain HTML table of every clip (all years);
// the RSS (ViewPublisherRSS.php?view_id=N&mode=agendas|video) is capped at 100 items, so it is only the fallback.
// j.council = { platform: "granicus", client, views: [{ id: 129, body: "City Council" }, ...], label }
import { fetchHtml, fetchText, toYmd, absUrl } from "./_http.js";

const cell = (row, header) => { const m = row.match(new RegExp(`<td[^>]*headers="${header}[^"]*"[^>]*>([\\s\\S]*?)</td>`, "i")); return m ? m[1] : ""; };
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const href = (h, base) => { const m = h.match(/href="([^"]+)"/i); return m ? absUrl(m[1], base) : ""; };

export function parseView(html, j, view) {
  const base = `https://${j.council.client}.granicus.com/`;
  const out = [];
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const clip = row.match(/clip_id=(\d+)/)?.[1]; if (!clip) continue;
    const name = text(cell(row, "Name")) || view.body || "Meeting";
    const date = toYmd(text(cell(row, "Date"))); if (!date) continue;
    const agenda = href(cell(row, "Agenda"), base), minutes = href(cell(row, "Minutes"), base) || href(cell(row, "Journal"), base);
    const transcript = row.match(/TranscriptViewer\.php\?[^"']+/)?.[0], mp4 = row.match(/https?:\/\/[^"']+\.mp4/)?.[0] ?? "", mp3 = row.match(/https?:\/\/[^"']+\.mp3/)?.[0] ?? "";
    out.push({
      id: `granicus-${view.id}-${clip}`, platform: "granicus", body: view.body ?? name, name, date, time: "", canceled: /cancel/i.test(name),
      agenda_url: agenda, minutes_url: minutes, packet_url: "", clip_id: +clip, view_id: view.id,
      video_url: `${base}MediaPlayer.php?view_id=${view.id}&clip_id=${clip}`, transcript_url: transcript ? absUrl(transcript.replace(/&amp;/g, "&"), base) : "", mp4_url: mp4, mp3_url: mp3,
    });
  }
  return out;
}

export function parseRss(xml, j, view) {
  const base = `https://${j.council.client}.granicus.com/`, out = [];
  for (const item of xml.split(/<item>/).slice(1)) {
    const title = text(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""), clip = item.match(/clip_id=(\d+)/)?.[1];
    const p = item.match(/yr='(\d{4})' mo='(\d{2})' day='(\d{2})'/);
    const date = p ? `${p[1]}-${p[2]}-${p[3]}` : toYmd(title); if (!clip || !date) continue;
    out.push({ id: `granicus-${view.id}-${clip}`, platform: "granicus", body: view.body ?? title.replace(/\s*-\s*\w+day\s*-.*$/, ""), name: title, date, time: "", canceled: /cancel/i.test(title),
      agenda_url: `${base}AgendaViewer.php?view_id=${view.id}&clip_id=${clip}`, minutes_url: "", packet_url: "", clip_id: +clip, view_id: view.id, video_url: `${base}MediaPlayer.php?view_id=${view.id}&clip_id=${clip}`, transcript_url: "" });
  }
  return out;
}

export async function listMeetings(j) {
  const base = `https://${j.council.client}.granicus.com/`, out = [];
  for (const view of j.council.views ?? []) {
    let rows = [];
    try { rows = parseView(await fetchHtml(`${base}ViewPublisher.php?view_id=${view.id}`, { timeout: 120000 }), j, view); } catch (e) { console.error(`granicus ${j.id} view ${view.id}: ${e.message}`); }
    if (!rows.length) { try { rows = parseRss(await fetchHtml(`${base}ViewPublisherRSS.php?view_id=${view.id}&mode=agendas`), j, view); } catch (e) { console.error(`granicus rss ${j.id} view ${view.id}: ${e.message}`); } }
    out.push(...rows);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

const unpublished = (t) => !t || /not currently published|has not been published|try again later/i.test(t.slice(0, 300));
/** Agenda/minutes links are HTML pages or extension-less PDFs; fetchText sniffs. Granicus "not published" stubs become "". */
export async function meetingText(m) {
  const out = { agenda_text: "", minutes_text: "" };
  if (m.agenda_url) out.agenda_text = await fetchText(m.agenda_url).then((t) => (unpublished(t) ? "" : t)).catch(() => "");
  if (m.minutes_url) out.minutes_text = await fetchText(m.minutes_url).then((t) => (unpublished(t) ? "" : t)).catch(() => "");
  return out;
}
