// CivicClerk (CivicPlus) agenda portals: <client>.portal.civicclerk.com is a JS app over an open OData API (verified 2026-10-17, Monterey Park):
//   GET https://<client>.api.civicclerk.com/v1/Events?$filter=startDateTime lt 2026-10-17T00:00:00Z&$orderby=startDateTime desc&$top=200&$skip=0
//       -> { value: [{ id, eventName, startDateTime (UTC), categoryName, hasAgenda, externalMediaUrl,
//                      publishedFiles: [{ fileId, type: "Agenda"|"Agenda Packet"|"Minutes"|..., name, url }] }] }   ($count=true gives @odata.count)
//   GET https://<client>.api.civicclerk.com/v1/Meetings/GetMeetingFileStream(fileId=N,plainText=false)  -> application/pdf
// j.council = { platform: "civicclerk", client: "montereyparkca", since?: "2019", bodies?: [regex strings over categoryName], label }
import { fetchJson, fetchText } from "./_http.js";

const api = (j) => `https://${j.council.client}.api.civicclerk.com/v1`;
const fileUrl = (j, id) => `${api(j)}/Meetings/GetMeetingFileStream(fileId=${id},plainText=false)`;

export async function listMeetings(j) {
  const since = `${Number(j.council.since) || new Date().getFullYear() - 2}-01-01T00:00:00Z`, bodies = (j.council.bodies ?? []).map((re) => new RegExp(re, "i"));
  // the API serves at most 15 events per page whatever $top says; j.council.categories (exact categoryName values) filters server-side so a
  // council-only pull is ~60 pages instead of the whole calendar (Monterey Park: 837 council events among ~3,000)
  const cats = (j.council.categories ?? []).map((c) => `categoryName eq '${c.replace(/'/g, "''")}'`).join(" or ");
  const filter = `startDateTime ge ${since}${cats ? ` and (${cats})` : ""}`, out = [];
  for (let skip = 0, page = 0; page < 400; page++) {
    const q = new URLSearchParams({ $filter: filter, $orderby: "startDateTime desc", $top: "200", $skip: String(skip) });
    const { value = [] } = await fetchJson(`${api(j)}/Events?${q}`); if (!value.length) break; skip += value.length;
    for (const e of value) {
      const body = e.categoryName ?? j.council.label ?? "City Council"; if (bodies.length && !bodies.some((re) => re.test(body))) continue;
      const files = e.publishedFiles ?? [], pick = (re) => files.find((f) => re.test(`${f.type} ${f.name}`) && !/spanish|español/i.test(f.name));
      const agenda = pick(/^Agenda$/i) ?? pick(/^Agenda(?! Packet)/i) ?? pick(/agenda/i), minutes = pick(/minutes|action/i), packet = pick(/packet/i);
      const local = new Date(e.startDateTime), date = local.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }), time = local.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
      out.push({ id: `civicclerk-${e.id}`, platform: "civicclerk", body, name: (e.eventName ?? body).trim(), date, time, canceled: /cancel/i.test(e.eventName ?? ""),
        agenda_url: agenda ? fileUrl(j, agenda.fileId) : "", minutes_url: minutes ? fileUrl(j, minutes.fileId) : "", packet_url: packet ? fileUrl(j, packet.fileId) : "",
        video_url: e.externalMediaUrl || "", portal_url: `https://${j.council.client}.portal.civicclerk.com/event/${e.id}/files` });
    }
  }
  return out.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

const txt = (u) => (u ? fetchText(u, { timeout: 180000 }).then((t) => (t.length < 80 ? "" : t)).catch(() => "") : Promise.resolve(""));
export async function meetingText(m) { return { agenda_text: await txt(m.agenda_url || m.packet_url), minutes_text: await txt(m.minutes_url) }; }
