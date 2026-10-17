// Everything Santa Monica beyond the city's own CKAN + council records:
//  - local news (RSS/Atom feeds + Google/Bing News queries + Granicus CityTV video feeds) -> kind:"news" docs
//  - city GIS open-data hub + LA County eGIS hub (ArcGIS REST layers) -> kind:"gis" docs, queried live with queryGis()
//  - live federal/state/county/vendor APIs (weather, tides, quakes, air, beach grades, scooters, bus alerts, flights,
//    traffic cams, health, jobs numbers, assessor parcels, Wikipedia, data.ca.gov, Census) -> live[kind]()
// No deps: regex feed parsing, hand-rolled protobuf reader for GTFS-RT. Every probe URL here answered on 2026-10-17.
import fs from "node:fs";

import { jurById, countyOf, dataDir, SERVED } from "./jurisdictions.js";

const UA = { "User-Agent": "Mozilla/5.0 (GovAI civic assistant; +https://github.com/liamdowd/GovAI)" };
const SM = jurById("santa-monica"); // default jurisdiction for every function below; pass another entry to scope it
const geo = (j) => ({ lat: j.center?.[0], lon: j.center?.[1], bbox: j.bbox ?? (j.center ? [j.center[1] - 0.08, j.center[0] - 0.07, j.center[1] + 0.08, j.center[0] + 0.07] : null) }); // [xmin,ymin,xmax,ymax]; ~8 km box when no limits are known
const strip = (h = "") => h.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;|&#xa0;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#8217;|&rsquo;/g, "'").replace(/&#821[12];|&[lr]dquo;/g, '"').replace(/&#8211;|&ndash;/g, "–").replace(/&#8212;|&mdash;/g, " - ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

async function getJson(url, opts = {}) {
  const r = await fetch(url, { headers: { ...UA, ...opts.headers }, redirect: "follow", signal: AbortSignal.timeout(opts.timeout ?? 20000) });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 120)}`);
  return r.json();
}
async function getText(url, timeout = 20000) {
  const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 120)}`);
  return r.text();
}

/* ------------------------------------------------------------------ news ------------------------------------------------------------------ */
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
export const FEEDS = [
  { id: "smdp", name: "Santa Monica Daily Press", url: "https://smdp.com/feed/" },
  { id: "smmirror", name: "Santa Monica Mirror", url: "https://smmirror.com/feed/" },
  { id: "smnext", name: "Santa Monica Next", url: "https://www.santamonicanext.org/feed/" },
  { id: "observer", name: "Santa Monica Observer", url: "https://www.smobserved.com/rss/" },
  { id: "patch", name: "Patch Santa Monica", url: "https://patch.com/feeds/california/santamonica" },
  { id: "canyon", name: "Canyon News", url: "https://www.canyon-news.com/category/santa-monica/feed" },
  { id: "reddit", name: "r/SantaMonica", url: "https://www.reddit.com/r/santamonica/new/.rss" },
  { id: "latimes", name: "Los Angeles Times", url: "https://www.latimes.com/california/rss2.0.xml", filter: /santa monica/i },
  { id: "bing", name: "Bing News", url: "https://www.bing.com/news/search?q=%22Santa+Monica%22&format=rss" },
  { id: "gn", name: "Google News", url: gnews('"Santa Monica" when:30d') },
  { id: "gn-lookout", name: "Santa Monica Lookout", url: gnews("site:surfsantamonica.com") },
  { id: "gn-westside", name: "Westside Current", url: gnews('site:westsidecurrent.com "Santa Monica"') },
  { id: "gn-latimes", name: "Los Angeles Times", url: gnews('site:latimes.com "Santa Monica"') },
  { id: "gn-kcrw", name: "KCRW", url: gnews('site:kcrw.com "Santa Monica"') },
  { id: "gn-laist", name: "LAist", url: gnews('site:laist.com "Santa Monica"') },
  { id: "gn-city", name: "City of Santa Monica news", url: gnews("site:santamonica.gov") },
  { id: "gn-schools", name: "Google News · schools", url: gnews('"Santa Monica College" OR SMMUSD OR "Santa Monica-Malibu"') },
  { id: "gn-places", name: "Google News · landmarks", url: gnews('"Big Blue Bus" OR "Santa Monica Pier" OR "Third Street Promenade" OR "Santa Monica Airport"') },
  { id: "gn-safety", name: "Google News · safety & council", url: gnews('"Santa Monica" (police OR fire OR "city council" OR "rent control")') },
  ...[2, 3, 4, 5, 6, 7, 8].map((v) => ({ id: `citytv${v}`, name: "Santa Monica CityTV", url: `https://santamonica.granicus.com/ViewPublisherRSS.php?view_id=${v}` })),
];

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1].trim() : ""; };
/** RSS 2.0 or Atom -> [{title, url, date (ISO), text, publisher}] */
export function parseFeed(xml, feed = {}) {
  const items = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(([, , body]) => {
    let url = tag(body, "link") || (body.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i) ?? body.match(/<link[^>]*href="([^"]+)"/i))?.[1] || "";
    url = strip(url);
    const bing = url.match(/[?&]url=([^&]+)/); if (/bing\.com\/news\/apiclick/.test(url) && bing) url = decodeURIComponent(bing[1]);
    const dateRaw = tag(body, "pubDate") || tag(body, "published") || tag(body, "updated") || tag(body, "dc:date");
    const d = new Date(dateRaw); const date = isNaN(d) ? "" : d.toISOString().slice(0, 10);
    const content = tag(body, "content:encoded") || tag(body, "content") || tag(body, "description") || tag(body, "summary");
    const publisher = strip(tag(body, "source")) || feed.name || "";
    return { title: strip(tag(body, "title")), url, date, text: strip(strip(content)).slice(0, 2000), publisher, feed: feed.id }; // twice: Atom/Reddit escape the HTML itself
  }).filter((i) => i.title && i.url);
  return feed.filter ? items.filter((i) => feed.filter.test(i.title + " " + i.text)) : items;
}

const newsFile = (j) => `${dataDir(j)}/news.json`;
export const feedsFor = (j) => (j.id === "santa-monica" ? FEEDS : j.feeds ?? []);
const newsDoc = (i, j = SM) => ({
  kind: "news", jur: j.id, title: i.title, url: i.url, date: i.date, publisher: i.publisher, text: i.text,
  searchText: `${i.publisher} ${i.date} ${i.title} ${i.title} ${i.text}`,
});
/** Fetch every feed, merge new items into data/news.json, call onDocs(newDocs). Safe to call repeatedly (30-min refresh). */
export async function ingestNews(onDocs, log = console.error, j = SM) {
  const NEWS_FILE = newsFile(j);
  let store = {}; try { store = JSON.parse(fs.readFileSync(NEWS_FILE, "utf8")); } catch {}
  const fresh = []; let ok = 0;
  const queue = [...feedsFor(j)];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let f; (f = queue.shift());) {
      try {
        const items = parseFeed(await getText(f.url), f); ok++;
        for (const i of items) if (!store[i.url]) { store[i.url] = i; fresh.push(i); }
      } catch (e) { log(`news ${f.id}: ${e.message}`); }
    }
  }));
  // ponytail: keep the newest 20k items; drop the rest so the file and the BM25 index stay bounded
  const all = Object.values(store).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 20000);
  fs.mkdirSync(dataDir(j), { recursive: true });
  fs.writeFileSync(NEWS_FILE, JSON.stringify(Object.fromEntries(all.map((i) => [i.url, i]))));
  const first = fresh.length === all.length; // first run: index everything we have; later runs: only the new items
  onDocs((first ? all : fresh).map((i) => newsDoc(i, j)), { feeds: ok, total: all.length, fresh: fresh.length });
  return fresh.length;
}
export function loadNewsDocs(j = SM) { try { return Object.values(JSON.parse(fs.readFileSync(newsFile(j), "utf8"))).map((i) => newsDoc(i, j)); } catch { return []; } }

/* ------------------------------------------------------------------ GIS ------------------------------------------------------------------ */
const gisFile = (j) => `${dataDir(j)}/gis.json`;
// sub-layer noise (utility network annotation, symbol classes) and non-data items (apps, dashboards, slide decks)
const JUNK = /^(Default( \d+)?|Depth(Above|Below)( \d+)?|Misc( Anno(tation)?)?|Reducer|Tee|Cross|Zone|Meters|Standard|Active|Annotation|.*Anno(tation)?|Flow|Fitting|Manhole|Abandoned( Line)?|Lateral Line|Gravity Main|Catch Basin|Network Structure|Discharge Point|BMP|HYDRANT|UNSYNC.*|Sites|Locations|Streets|Addresses)$|PowerBI|Dashboard|Download Files|Web Map|Viewer|\bApp\b|Application|logo|Slides|Landing Page|Year in Review|AGOL|Imagery|Landscape Maintenance|DCFS|Unincorporated/i;
export const isJunkLayer = (title) => JUNK.test(title.trim());
const extraLayers = (j) => (j.gisExtra ?? []).map((l) => ({ kind: "gis", jur: j.id, org: j.short + " GIS", ...l }));
export async function loadGisCatalog(log = console.error, refresh = false, j = SM) {
  const GIS_FILE = gisFile(j);
  try { const c = JSON.parse(fs.readFileSync(GIS_FILE, "utf8")); if (!refresh) return c.layers; } catch { if (!refresh) return []; } // refresh = explicit collector run: always refetch
  const layers = [...extraLayers(j)];
  for (const cat of j.gis ?? []) {
    try {
      let dataset;
      for (let attempt = 1; ; attempt++) { // geohub.lacity.org drops connections intermittently at the TCP level; big feeds (~4 MB) stream slowly
        try { ({ dataset } = await getJson(cat.url, { timeout: 180000 })); break; }
        catch (e) { if (attempt >= 3) throw e; log(`gis catalog ${cat.org}: ${e.message}, retry ${attempt}`); await new Promise((r) => setTimeout(r, 5000 * attempt)); }
      }
      const seen = new Map(); // same layer is often published twice (MapServer + FeatureServer); keep one, prefer FeatureServer
      for (const d of dataset) {
        // Hub feeds list several GeoServices distributions per dataset (an Experience Builder app, a web map, the layer); take the layer
        const rest = (d.distribution ?? []).map((x) => x.accessURL ?? "").find((u) => /\/(FeatureServer|MapServer)\/\d+$/.test(u));
        if (!rest || isJunkLayer(d.title ?? "")) continue;
        const key = `${d.title.trim()}|${rest.replace(/\/(FeatureServer|MapServer)\//, "/")}`;
        if (seen.has(key) && !/FeatureServer/.test(rest)) continue;
        seen.set(key, { kind: "gis", jur: j.id, org: cat.org, title: d.title.trim(), url: d.landingPage ?? rest, service: rest, notes: strip(d.description ?? "").slice(0, 500), keywords: d.keyword ?? [], modified: d.modified?.slice(0, 10) });
      }
      layers.push(...seen.values());
    } catch (e) { log(`gis catalog ${cat.org}: ${e.message}`); }
  }
  if (!layers.length) { // every catalog fetch failed: keep what we had rather than overwrite a good cache with nothing
    try { const prev = JSON.parse(fs.readFileSync(GIS_FILE, "utf8")); if (prev.layers?.length) { log(`gis ${j.id}: refresh failed, keeping ${prev.layers.length} cached layers`); return prev.layers; } } catch {}
  }
  fs.mkdirSync(dataDir(j), { recursive: true });
  fs.writeFileSync(GIS_FILE, JSON.stringify({ fetched_at: Date.now(), layers }));
  return layers;
}
/** Jurisdictions with GIS catalogs configured (cities, counties, plus LA County context for Santa Monica). */
export const gisJurs = () => [...new Set([...SERVED, ...SERVED.map(countyOf).filter(Boolean)])].filter((j) => (j.gis?.length || j.gisExtra?.length));
export const gisDocs = (layers) => layers.map((l) => ({ ...l, searchText: `${l.org} ${l.title} ${l.title} ${l.notes} ${l.keywords.join(" ")}` }));

const layerMeta = new Map();
async function layerInfo(service) {
  if (!layerMeta.has(service)) layerMeta.set(service, await getJson(`${service}?f=json`));
  return layerMeta.get(service);
}
let lastGeocode = 0;
/** Address -> {lon, lat} inside the jurisdiction via Nominatim (bounded to its box when known, 1 req/s per their policy). */
export async function geocode(address, j = SM) {
  const wait = lastGeocode + 1100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastGeocode = Date.now();
  const place = j.kind === "county" ? `${j.short}, CA` : `${j.short}, CA`;
  const q = new RegExp(j.short, "i").test(address) ? address : `${address}, ${place}`;
  const params = { q, format: "json", limit: "1", countrycodes: "us" };
  if (j.bbox) { const [vb0, vb1, vb2, vb3] = j.bbox; Object.assign(params, { viewbox: `${vb0},${vb3},${vb2},${vb1}`, bounded: "1" }); }
  const hits = await getJson(`https://nominatim.openstreetmap.org/search?${new URLSearchParams(params)}`);
  if (!hits.length) throw new Error(`could not geocode "${address}" in ${j.short}`);
  return { lon: +hits[0].lon, lat: +hits[0].lat, display: hits[0].display_name };
}
const GIS_HOSTS = [...new Set(SERVED.flatMap((j) => [...(j.gisHosts ?? []), ...(countyOf(j)?.gisHosts ?? [])]))];
/** Query an ArcGIS REST layer by SQL where and/or by address (point-in-polygon, or within 250 m for point/line layers). */
/** point = { lon, lat } (the resident's device location) stands in for address when no address is given. */
export async function queryGis({ service_url, where = "", address = "", limit = 20, jur = "santa-monica", point: here = null }) {
  const host = service_url.match(/^https:\/\/([^/]+)\//)?.[1] ?? "";
  if (!GIS_HOSTS.includes(host) && !/(^|\.)arcgis\.com$/.test(host)) throw new Error(`service_url must be an arcgis.com REST layer or one of: ${GIS_HOSTS.join(", ")}`);
  const J = jurById(jur) ?? SM;
  const info = await layerInfo(service_url);
  const params = { where: where || "1=1", outFields: "*", returnGeometry: "false", f: "json", resultRecordCount: String(Math.min(Math.max(1, limit), 100)) };
  let point = null;
  if (address || here) {
    point = address ? await geocode(address, J) : { ...here, display: "your current location" };
    Object.assign(params, { geometry: `${point.lon},${point.lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects" });
    if (info.geometryType !== "esriGeometryPolygon") Object.assign(params, { distance: "250", units: "esriSRUnit_Meter" });
  }
  let r = await getJson(`${service_url}/query?${new URLSearchParams(params)}`);
  if (r.error) throw new Error(`${r.error.message} ${JSON.stringify(r.error.details ?? [])}. Fields: ${(info.fields ?? []).map((f) => f.name).join(", ")}`);
  // geocoders drop the point on the street centerline, which zoning/parcel polygons exclude: widen to 40 m before giving up
  if (point && !r.features?.length && !params.distance) r = await getJson(`${service_url}/query?${new URLSearchParams({ ...params, distance: "40", units: "esriSRUnit_Meter" })}`);
  const skip = /^(OBJECTID|Shape|GlobalID|SHAPE_|Shape__)/i;
  return {
    layer: info.name, geometry: info.geometryType, at: point ? { address: point.display, lon: point.lon, lat: point.lat } : undefined,
    total: r.features.length, exceeded: !!r.exceededTransferLimit,
    fields: (info.fields ?? []).filter((f) => !skip.test(f.name)).map((f) => `${f.name}:${f.type.replace("esriFieldType", "")}`),
    records: r.features.map((f) => Object.fromEntries(Object.entries(f.attributes).filter(([k, v]) => !skip.test(k) && v !== null && v !== ""))),
  };
}

/* ------------------------------------------------------------------ protobuf (GTFS-RT) ------------------------------------------------------------------ */
/** Minimal protobuf wire decoder: Buffer -> [{f, v}] where v is a number (varint), Buffer (length-delimited) or null. */
export function decodePb(buf) {
  const out = []; let i = 0;
  const varint = () => { let n = 0n, s = 0n; for (;;) { const b = buf[i++]; n |= BigInt(b & 0x7f) << s; if (b < 0x80) return n; s += 7n; } };
  while (i < buf.length) {
    const key = Number(varint()), f = key >> 3, wt = key & 7;
    if (wt === 0) out.push({ f, v: Number(varint()) });
    else if (wt === 1) { out.push({ f, v: buf.readDoubleLE(i) }); i += 8; }
    else if (wt === 2) { const len = Number(varint()); out.push({ f, v: buf.subarray(i, i + len) }); i += len; }
    else if (wt === 5) { out.push({ f, v: buf.readFloatLE(i) }); i += 4; }
    else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}
const pbStr = (msg, field) => { const ts = msg.find((x) => x.f === field); if (!ts) return ""; const tr = decodePb(ts.v).find((x) => x.f === 1); return tr ? decodePb(tr.v).find((x) => x.f === 1)?.v?.toString("utf8") ?? "" : ""; };
/** GTFS-RT FeedMessage -> [{header, description, url, routes}] */
export function gtfsAlerts(buf) {
  return decodePb(buf).filter((x) => x.f === 2).map((e) => decodePb(e.v).find((x) => x.f === 5)).filter(Boolean).map((a) => {
    const m = decodePb(a.v);
    const routes = [...new Set(m.filter((x) => x.f === 5).map((sel) => decodePb(sel.v).find((x) => x.f === 5)?.v?.toString("utf8")).filter(Boolean))];
    return { header: pbStr(m, 10), description: pbStr(m, 11), url: pbStr(m, 8), routes };
  });
}

/* ------------------------------------------------------------------ live APIs ------------------------------------------------------------------ */
const cache = new Map(); // ponytail: in-memory 5-min cache keyed by kind+query; fine for one process
const cached = async (key, ttl, fn) => { const h = cache.get(key); if (h && Date.now() - h.t < ttl) return h.v; const v = await fn(); cache.set(key, { t: Date.now(), v }); return v; };
const km = (a, b, c, d) => { const r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r; return 2 * 6371 * Math.asin(Math.sqrt(Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2)); };
const inBox = (lon, lat, [x0, y0, x1, y1]) => lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1;

const need = (v, what, j) => { if (!v) throw new Error(`${what} is not configured for ${j.short} yet`); return v; };
/** NWS forecast + zone for a point (points API), cached per jurisdiction. Santa Monica keeps its hand-set grid. */
async function nwsFor(j) {
  if (j.live?.nws) return { forecast: `https://api.weather.gov/gridpoints/${j.live.nws}/forecast`, zone: j.live.nwsZone, name: j.live.nwsName ?? j.live.nwsZone };
  const { lat, lon } = geo(j);
  return cached(`nws|${j.id}`, 864e5, async () => {
    const pt = await getJson(`https://api.weather.gov/points/${lat},${lon}`);
    const zone = pt.properties.forecastZone?.split("/").pop();
    return { forecast: pt.properties.forecast, zone, name: `${pt.properties.relativeLocation?.properties?.city ?? j.short} zone ${zone}` };
  });
}
export const live = {
  weather: async (_q, j = SM) => {
    const { lat, lon } = geo(j), nws = await nwsFor(j);
    const [fc, al] = await Promise.all([getJson(nws.forecast), nws.zone ? getJson(`https://api.weather.gov/alerts/active?zone=${nws.zone}`) : { features: [] }]);
    return { source: `National Weather Service (api.weather.gov), ${nws.name}`, url: `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`,
      forecast: fc.properties.periods.slice(0, 8).map((p) => ({ period: p.name, temp: `${p.temperature}°${p.temperatureUnit}`, wind: `${p.windSpeed} ${p.windDirection}`, forecast: p.detailedForecast })),
      alerts: al.features.map((f) => ({ event: f.properties.event, severity: f.properties.severity, headline: f.properties.headline, ends: f.properties.ends, description: f.properties.description?.slice(0, 600) })) };
  },
  tides: async (_q, j = SM) => {
    const station = need(j.live?.tide ?? countyOf(j)?.live?.tide, "a NOAA tide station", j), name = j.live?.tideName ?? countyOf(j)?.live?.tideName ?? station;
    const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${station}&units=english&time_zone=lst_ldt&format=json`;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }).replace(/-/g, "");
    const [t, w] = await Promise.all([getJson(`${base}&product=predictions&datum=MLLW&interval=hilo&begin_date=${today}&range=48`), getJson(`${base}&product=water_temperature&date=latest`)]);
    return { source: `NOAA CO-OPS station ${station} (${name})`, url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}`,
      tides_next_48h: (t.predictions ?? []).map((p) => ({ time: p.t, height_ft: +p.v, type: p.type === "H" ? "high" : "low" })), water_temp_f: w.data?.[0] ? { time: w.data[0].t, value: +w.data[0].v } : null };
  },
  earthquakes: async (_q, j = SM) => {
    const { lat, lon } = geo(j);
    const r = await getJson(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${lat}&longitude=${lon}&maxradiuskm=60&minmagnitude=1.5&limit=15&orderby=time&starttime=${new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)}`);
    return { source: `USGS earthquake catalog, 60 km of ${j.short}, last 30 days`, url: "https://earthquake.usgs.gov/earthquakes/map/",
      quakes: r.features.map((f) => ({ mag: f.properties.mag, place: f.properties.place, time: new Date(f.properties.time).toISOString(), depth_km: f.geometry.coordinates[2], url: f.properties.url })) };
  },
  air_quality: async (_q, j = SM) => {
    const { lat, lon } = geo(j);
    const r = await getJson(`https://airnowgovapi.com/reportingarea/get?latitude=${lat}&longitude=${lon}&stateCode=CA&maxDistance=50`);
    const area = j.live?.airnowArea;
    const rows = r.filter((x) => (area && x.reportingArea === area) || x.isPrimary).map((x) => ({ type: { O: "observed", F: "forecast", Y: "yesterday" }[x.dataType] ?? x.dataType, date: x.validDate, time: x.time, parameter: x.parameter, aqi: x.aqi, category: x.category, site: x.siteName, area: x.reportingArea, action_day: x.isActionDay, discussion: x.discussion || undefined }));
    return { source: `AirNow (EPA / air district), ${area ?? rows[0]?.area ?? "nearest"} reporting area`, url: `https://www.airnow.gov/?city=${encodeURIComponent(j.short)}&state=CA&country=USA`, readings: rows };
  },
  beach_water_quality: async (_q, j = SM) => {
    const county = need(j.live?.beachCounty ?? countyOf(j)?.live?.beachCounty, "a beach-grade county", j), { lat, lon } = geo(j);
    const r = await getJson(`https://admin.beachreportcard.org/api/locations/?county=${encodeURIComponent(county)}`); // API ignores lat/lng; filter locally
    const near = r.map((x) => x._source).filter((s) => s?.active && s.geo?.[0]).map((s) => ({ km: +km(lat, lon, +s.geo[0], +s.geo[1]).toFixed(1), s })).filter((x) => x.km < (j.kind === "county" ? 60 : 8)).sort((a, b) => a.km - b.km)
      .map(({ km, s }) => ({ beach: s.title?.trim(), km_from_center: km, dry_weather_grade: s.dry_grade, wet_weather_grade: s.wet_grade, graded: s.grade_updated?.slice(0, 10), note: s.grade_note || undefined, annual: s.annual_year ? { year: s.annual_year, summer_dry: s.annual_summer_dry, winter_dry: s.annual_winter_dry, wet: s.annual_year_wet } : undefined, alerts: s.alerts?.length ? s.alerts : undefined, factors: s.factorsAffectingWater || undefined }));
    return { source: "Heal the Bay Beach Report Card (weekly grades; ns = not sampled)", url: "https://beachreportcard.org/", beaches: near };
  },
  scooters: async (near = "", j = SM, here = null) => {
    const g = need(j.live?.gbfs, "a scooter/bike-share GBFS feed", j);
    const r = await getJson(g.url);
    const bikes = r.data.bikes.filter((b) => !b.is_disabled && !b.is_reserved);
    const out = { source: `GBFS feed for ${j.short} (updated every minute)`, url: g.site, available: Object.fromEntries(Object.entries(Object.groupBy(bikes, (b) => b.vehicle_type ?? b.vehicle_type_id)).map(([k, v]) => [k, v.length])), note: g.note };
    if (near || here) { const p = near ? await geocode(near, j) : { ...here, display: "your current location" }; out.nearest = bikes.map((b) => ({ type: b.vehicle_type, meters: Math.round(km(p.lat, p.lon, b.lat, b.lon) * 1000), range_km: Math.round((b.current_range_meters ?? 0) / 1000) })).sort((a, b) => a.meters - b.meters).slice(0, 5); out.near = p.display; }
    return out;
  },
  bus_alerts: async (_q, j = SM) => {
    const t = need(j.live?.gtfsrt, "a transit GTFS-Realtime alerts feed", j);
    const r = await fetch(t.url, { headers: UA, signal: AbortSignal.timeout(15000) });
    return { source: `${t.name} GTFS-Realtime service alerts`, url: t.site, alerts: gtfsAlerts(Buffer.from(await r.arrayBuffer())) };
  },
  flights_over_airport: async (_q, j = SM) => {
    const a = need(j.live?.airport, "an airport box", j), [x0, y0, x1, y1] = a.box;
    const r = await getJson(`https://opensky-network.org/api/states/all?lamin=${y0}&lomin=${x0}&lamax=${y1}&lomax=${x1}`);
    return { source: `OpenSky Network ADS-B, box around ${a.name}`, url: a.globe, time: new Date(r.time * 1000).toISOString(),
      aircraft: (r.states ?? []).map((s) => ({ callsign: s[1]?.trim() || undefined, altitude_ft: s[7] != null ? Math.round(s[7] * 3.281) : (s[8] ? 0 : undefined), on_ground: s[8], speed_kt: s[9] != null ? Math.round(s[9] * 1.944) : undefined, heading: s[10] != null ? Math.round(s[10]) : undefined, lat: s[6], lon: s[5] })) };
  },
  traffic_cameras: async (_q, j = SM) => {
    const d = need(j.live?.caltrans ?? countyOf(j)?.live?.caltrans, "a Caltrans district", j), box = j.live?.camsBox ?? geo(j).bbox;
    const r = await getJson(`https://cwwp2.dot.ca.gov/data/d${+d}/cctv/cctvStatusD${d.padStart(2, "0")}.json`);
    return { source: `Caltrans District ${+d} CCTV`, url: "https://cwwp2.dot.ca.gov/vm/iframemap.htm",
      cameras: r.data.map((x) => x.cctv).filter((c) => inBox(+c.location.longitude, +c.location.latitude, box)).map((c) => ({ name: c.location.locationName, route: c.location.route, direction: c.location.direction, in_service: c.inService, image: c.imageData?.static?.currentImageURL })) };
  },
  health_stats: async (_q, j = SM) => {
    const name = j.live?.placesName ?? j.short;
    const r = await getJson(`https://data.cdc.gov/resource/eav7-hnsx.json?locationname=${encodeURIComponent(name)}&stateabbr=CA&datavaluetypeid=AgeAdjPrv&$select=year,category,measure,data_value,data_value_unit&$order=year%20DESC&$limit=200`);
    const seen = new Set();
    return { source: `CDC PLACES: local health estimates, ${name} city (age-adjusted prevalence)`, url: "https://www.cdc.gov/places/", measures: r.filter((x) => !seen.has(x.measure) && seen.add(x.measure)).map((x) => ({ year: x.year, category: x.category, measure: x.measure, value: `${x.data_value}${x.data_value_unit}` })) };
  },
  unemployment: async (_q, j = SM) => {
    const place = need(j.live?.censusPlace, "a Census place code (for BLS LAUS)", j), base = `LAUCT06${place}0000000`;
    const ids = { unemployment_rate_pct: `${base}03`, unemployed: `${base}04`, employed: `${base}05`, labor_force: `${base}06` };
    const y = new Date().getFullYear(); // ponytail: unregistered BLS v2 rejects multi-series GETs, so 4 calls; cached a day (25 calls/day cap)
    const series = await Promise.all(Object.values(ids).map((id) => getJson(`https://api.bls.gov/publicAPI/v2/timeseries/data/${id}?startyear=${y - 1}&endyear=${y}`).then((r) => r.Results?.series?.[0]?.data ?? [])));
    return { source: `BLS Local Area Unemployment Statistics, ${j.short} city (not seasonally adjusted)`, url: `https://data.bls.gov/timeseries/${ids.unemployment_rate_pct}`, series: Object.fromEntries(Object.keys(ids).map((k, i) => [k, series[i].slice(0, 13).map((d) => ({ period: `${d.year}-${d.period.slice(1)}`, value: +d.value, preliminary: d.footnotes?.some((f) => f.code === "P") || undefined }))])) };
  },
  wikipedia: async (query = "", j = SM) => {
    const q = query || `${j.short}, California`;
    const s = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(new RegExp(j.short, "i").test(q) ? q : q + " " + j.short)}&srlimit=4&format=json`);
    const titles = s.query.search.map((x) => x.title);
    if (!titles.length) return { source: "Wikipedia", results: [] };
    const e = await getJson(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(titles.join("|"))}&format=json`);
    return { source: "Wikipedia", results: Object.values(e.query.pages).map((p) => ({ title: p.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`, extract: p.extract?.slice(0, 1200) })) };
  },
  property: async (address, j = SM, here = null) => {
    if (!address && !here) throw new Error("property needs an address in query (or the resident's device location)");
    const A = need(countyOf(j)?.live?.assessor ?? j.live?.assessor, "an assessor roll", j); // LA County publishes its roll as an ArcGIS table; other counties: Phase B
    const m = address ? address.match(/^\s*(\d+)\s+([NSEW]\.?\s+)?([^,#]+?)(?:\s+(?:apt|unit|#|ste|suite)\s*\S+)?(?:,|$)/i) : null;
    if (address && !m) throw new Error("give a street address like '1685 Main St'");
    const street = (m?.[3] ?? "").trim().replace(new RegExp(`\\s+${j.short}$`, "i"), "").replace(/\s+(st|street|ave|avenue|blvd|boulevard|dr|drive|pl|place|ct|court|way|ter|terrace|ln|lane|rd|road)\.?$/i, "").toUpperCase().replace(/'/g, "''");
    const q = async (where) => (await getJson(`${A.url}/query?${new URLSearchParams({ where, outFields: "*", returnGeometry: "false", resultRecordCount: "10", f: "json" })}`)).features?.map((f) => f.attributes) ?? [];
    let rows = m ? await q(`SitusHouseNo = ${+m[1]} AND UPPER(SitusStreet) LIKE '${street}%' AND SitusCity LIKE '${j.short.toUpperCase()}%'`) : [];
    if (!rows.length) { const p = m ? await geocode(address, j) : here; rows = await q(`CENTER_LAT BETWEEN ${p.lat - 0.0008} AND ${p.lat + 0.0008} AND CENTER_LON BETWEEN ${p.lon - 0.001} AND ${p.lon + 0.001}`); } // ~90 m box: public parcels often have a blank situs
    const keep = /^(AIN|AssessorID|PropertyLocation|UseType|UseCodeDescChar\d|YearBuilt|EffectiveYearBuilt|SQFTmain|Bedrooms|Bathrooms|Units|RecordingDate|Roll_LandValue|Roll_ImpValue|Roll_totLandImp|Roll_HomeOwnersExemp|Roll_TotalValue|netTaxableValue|isTaxableParcel|RollYear|SitusUnit|SitusZIP5)$/;
    return { source: A.name, url: rows[0] ? `${A.portal}/parceldetail/${rows[0].AIN}` : `${A.portal}/`, note: "Public assessment record; values are assessed (Prop 13 base year + 2%/yr), not market.",
      parcels: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => keep.test(k) && v !== null && v !== "" && v !== 0))) };
  },
  ca_open_data: async (query = "", j = SM) => {
    const q = query || j.short;
    const r = await getJson(`https://data.ca.gov/api/3/action/package_search?q=${encodeURIComponent(q)}&rows=6`);
    return { source: "California Open Data Portal (data.ca.gov)", url: `https://data.ca.gov/dataset?q=${encodeURIComponent(q)}`, note: `Query rows with query_dataset using portal="california" and a resource_id; filter on jurisdiction/city = "${j.short}" where the dataset has such a field.`,
      datasets: r.result.results.map((p) => ({ title: p.title, org: p.organization?.title, url: `https://data.ca.gov/dataset/${p.name}`, notes: strip(p.notes ?? "").slice(0, 300), resources: (p.resources ?? []).filter((x) => x.datastore_active).map((x) => ({ resource_id: x.id, name: x.name })) })) };
  },
  census: async (_q, j = SM) => {
    const key = process.env.CENSUS_API_KEY, place = need(j.live?.censusPlace, "a Census place code", j);
    const url = `https://data.census.gov/profile/${j.live.censusName ?? j.short.replace(/ /g, "_") + "_city,_California"}?g=160XX00US06${place}`;
    if (!key) return { source: "US Census Bureau ACS", url, note: "CENSUS_API_KEY not set; point the resident to the profile page." };
    const vars = { population: "DP05_0001E", median_age: "DP05_0018E", median_household_income: "DP03_0062E", poverty_rate_pct: "DP03_0128PE", bachelors_or_higher_pct: "DP02_0068PE", foreign_born_pct: "DP02_0094PE", housing_units: "DP04_0001E", renter_occupied_pct: "DP04_0047PE", median_home_value: "DP04_0089E", median_gross_rent: "DP04_0134E", commute_public_transit_pct: "DP03_0021PE", work_from_home_pct: "DP03_0024PE" };
    const [h, r] = await getJson(`https://api.census.gov/data/2023/acs/acs5/profile?get=${Object.values(vars).join(",")}&for=place:${place}&in=state:06&key=${key}`);
    return { source: `US Census Bureau, ACS 5-year 2019–2023, ${j.short} city`, url, values: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, +r[h.indexOf(v)]])) };
  },
};
export const LIVE_KINDS = Object.keys(live);
const TTL = { unemployment: 864e5, health_stats: 864e5, census: 864e5, wikipedia: 3600e3, property: 3600e3, ca_open_data: 3600e3, scooters: 60e3, flights_over_airport: 60e3 };
export const liveData = (kind, query = "", jur = "santa-monica", here = null) => {
  if (!live[kind]) throw new Error(`unknown kind; one of ${LIVE_KINDS.join(", ")}`);
  const j = jurById(jur) ?? SM, h = here && !query ? { lon: +here.lon.toFixed(3), lat: +here.lat.toFixed(3) } : null; // ~100 m cache granularity
  return cached(`${j.id}|${kind}|${query}|${h ? `${h.lat},${h.lon}` : ""}`, TTL[kind] ?? 300e3, () => live[kind](query, j, h));
};
export const LIVE_HELP = {
  weather: "7-day NWS forecast + active alerts (heat, wind, surf, flood) for the jurisdiction",
  tides: "next 48 h high/low tides and ocean water temperature at the nearest NOAA station",
  earthquakes: "earthquakes within 60 km in the last 30 days",
  air_quality: "current and forecast AQI (ozone, PM2.5, PM10) for the local reporting area",
  beach_water_quality: "Heal the Bay grades for the nearby beach monitoring sites",
  scooters: "e-scooters/e-bikes available right now where a GBFS feed exists; query = address to get the nearest ones",
  bus_alerts: "local transit detours, stop closures and service alerts right now (where a GTFS-RT feed is configured)",
  flights_over_airport: "aircraft currently over/around the local airport (noise questions)",
  traffic_cameras: "Caltrans live camera images on the freeways/highways in the jurisdiction",
  health_stats: "CDC PLACES health prevalence estimates for the city (asthma, obesity, insurance, etc.)",
  unemployment: "BLS monthly unemployment rate, labor force, employment for the city",
  wikipedia: "encyclopedia background on a local place, person or history topic; query = topic",
  property: "county assessor record for a parcel: use, year built, sq ft, units, assessed values; query = street address (LA County only so far)",
  ca_open_data: "find California state datasets (housing element progress, EDD, DOJ, etc.) to query with query_dataset portal=california; query = keywords",
  census: "ACS 5-year demographic profile for the city (needs CENSUS_API_KEY)",
};
