// A jurisdiction with more than one agenda system (LA City: PrimeGov 2016-> + Granicus 2008-2021; Long Beach: PrimeGov + Legistar
// history). j.council = { platform: "multi", sources: [{ platform, ...config }], label }. Records remember their source so
// meetingText dispatches back to the right adapter. ponytail: Legistar (a council.js built-in) is not composable here yet.
import { fetchText } from "./_http.js";

const mods = new Map();
const load = async (platform) => mods.get(platform) ?? mods.set(platform, await import(`./${platform}.js`)).get(platform);
const sub = (j, src) => ({ ...j, council: { ...src, label: j.council.label } });

export async function listMeetings(j) {
  const out = [];
  for (const src of j.council.sources) {
    try { const mod = await load(src.platform); out.push(...(await mod.listMeetings(sub(j, src))).map((r) => ({ ...r, source: src.platform }))); }
    catch (e) { console.error(`multi ${j.id} ${src.platform}: ${e.message}`); }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
export async function meetingText(m, j) {
  const src = j.council.sources.find((s) => s.platform === (m.source ?? m.platform)) ?? j.council.sources[0];
  const mod = await load(src.platform);
  if (mod.meetingText) return mod.meetingText(m, sub(j, src));
  return { agenda_text: m.agenda_url ? await fetchText(m.agenda_url).catch(() => "") : "", minutes_text: m.minutes_url ? await fetchText(m.minutes_url).catch(() => "") : "" };
}
