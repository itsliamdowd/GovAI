// Everything Santa Monica beyond the city's own CKAN + council records:
//  - local news (RSS/Atom feeds + Google/Bing News queries + Granicus CityTV video feeds) -> kind:"news" docs
//  - city GIS open-data hub + LA County eGIS hub (ArcGIS REST layers) -> kind:"gis" docs, queried live with queryGis()
//  - live federal/state/county/vendor APIs (weather, tides, quakes, air, beach grades, scooters, bus alerts, flights,
//    traffic cams, health, jobs numbers, assessor parcels, Wikipedia, data.ca.gov, Census) -> live[kind]()
// No deps: regex feed parsing, hand-rolled protobuf reader for GTFS-RT. Every probe URL here answered on 2026-10-17.
import fs from "node:fs";

const UA = { "User-Agent": "Mozilla/5.0 (SantaMonicaAssistant; +https://github.com/liamdowd/GovAI)" };
const SM = { lat: 34.0195, lon: -118.4912, bbox: [-118.5176, 33.9950, -118.4432, 34.0506] }; // [xmin,ymin,xmax,ymax]
const strip = (h = "") => h.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;|&#xa0;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#8217;|&rsquo;/g, "'").replace(/&#821[12];|&[lr]dquo;/g, '"').replace(/&#8211;|&ndash;/g, "–").replace(/&#8212;|&mdash;/g, "—").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
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

const NEWS_FILE = "./data/news.json";
const newsDoc = (i) => ({
  kind: "news", title: i.title, url: i.url, date: i.date, publisher: i.publisher, text: i.text,
  searchText: `${i.publisher} ${i.date} ${i.title} ${i.title} ${i.text}`,
});
/** Fetch every feed, merge new items into data/news.json, call onDocs(newDocs). Safe to call repeatedly (30-min refresh). */
export async function ingestNews(onDocs, log = console.error) {
  let store = {}; try { store = JSON.parse(fs.readFileSync(NEWS_FILE, "utf8")); } catch {}
  const fresh = []; let ok = 0;
  const queue = [...FEEDS];
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
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(NEWS_FILE, JSON.stringify(Object.fromEntries(all.map((i) => [i.url, i]))));
  const first = fresh.length === all.length; // first run: index everything we have; later runs: only the new items
  onDocs((first ? all : fresh).map(newsDoc), { feeds: ok, total: all.length, fresh: fresh.length });
  return fresh.length;
}
export function loadNewsDocs() { try { return Object.values(JSON.parse(fs.readFileSync(NEWS_FILE, "utf8"))).map(newsDoc); } catch { return []; } }

/* ------------------------------------------------------------------ GIS ------------------------------------------------------------------ */
const GIS_FILE = "./data/gis.json";
const CATALOGS = [
  { org: "City of Santa Monica GIS", url: "https://gis-smgov.opendata.arcgis.com/api/feed/dcat-us/1.1.json" },
  { org: "LA County eGIS", url: "https://egis-lacounty.hub.arcgis.com/api/feed/dcat-us/1.1.json" },
];
// sub-layer noise (utility network annotation, symbol classes) and non-data items (apps, dashboards, slide decks)
const JUNK = /^(Default( \d+)?|Depth(Above|Below)( \d+)?|Misc( Anno(tation)?)?|Reducer|Tee|Cross|Zone|Meters|Standard|Active|Annotation|.*Anno(tation)?|Flow|Fitting|Manhole|Abandoned( Line)?|Lateral Line|Gravity Main|Catch Basin|Network Structure|Discharge Point|BMP|HYDRANT|UNSYNC.*|Sites|Locations|Streets|Addresses)$|PowerBI|Dashboard|Download Files|Web Map|Viewer|\bApp\b|Application|logo|Slides|Landing Page|Year in Review|AGOL|Imagery|Landscape Maintenance|DCFS|Unincorporated/i;
export const isJunkLayer = (title) => JUNK.test(title.trim());
const COUNTY_EXTRA = [
  [27, "Supervisorial District (Current)", "county supervisor board of supervisors"], [29, "Congressional District (2021)", "congress congressman congresswoman house representative"],
  [30, "State Assembly District (2021)", "assemblymember state assembly"], [31, "State Senate District (2021)", "state senator"],
].map(([id, name, syn]) => ({
  kind: "gis", org: "LA County eGIS", title: `LA County ${name}`, url: "https://egis-lacounty.hub.arcgis.com/", service: `https://public.gis.lacounty.gov/public/rest/services/LACounty_Dynamic/Political_Boundaries/MapServer/${id}`,
  notes: `Which ${name.replace(/ \(.*\)/, "")} a Santa Monica address falls in (${syn}). Query with an address.`, keywords: ["district", "representative", "elected", "who represents me", "my", ...syn.split(" ")],
}));
export async function loadGisCatalog(log = console.error) {
  try { const c = JSON.parse(fs.readFileSync(GIS_FILE, "utf8")); if (Date.now() - c.fetched_at < 24 * 3600e3) return c.layers; } catch {}
  const layers = [...COUNTY_EXTRA];
  for (const cat of CATALOGS) {
    try {
      const { dataset } = await getJson(cat.url, { timeout: 60000 });
      const seen = new Map(); // same layer is often published twice (MapServer + FeatureServer); keep one, prefer FeatureServer
      for (const d of dataset) {
        const rest = (d.distribution ?? []).find((x) => /GeoServices/i.test(x.format ?? ""))?.accessURL;
        if (!rest || !/\/(FeatureServer|MapServer)\/\d+$/.test(rest) || isJunkLayer(d.title ?? "")) continue;
        const key = `${d.title.trim()}|${rest.replace(/\/(FeatureServer|MapServer)\//, "/")}`;
        if (seen.has(key) && !/FeatureServer/.test(rest)) continue;
        seen.set(key, { kind: "gis", org: cat.org, title: d.title.trim(), url: d.landingPage ?? rest, service: rest, notes: strip(d.description ?? "").slice(0, 500), keywords: d.keyword ?? [], modified: d.modified?.slice(0, 10) });
      }
      layers.push(...seen.values());
    } catch (e) { log(`gis catalog ${cat.org}: ${e.message}`); }
  }
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(GIS_FILE, JSON.stringify({ fetched_at: Date.now(), layers }));
  return layers;
}
export const gisDocs = (layers) => layers.map((l) => ({ ...l, searchText: `${l.org} ${l.title} ${l.title} ${l.notes} ${l.keywords.join(" ")}` }));

const layerMeta = new Map();
async function layerInfo(service) {
  if (!layerMeta.has(service)) layerMeta.set(service, await getJson(`${service}?f=json`));
  return layerMeta.get(service);
}
let lastGeocode = 0;
/** Address -> {lon, lat} inside Santa Monica via Nominatim (bounded box, 1 req/s per their policy). */
export async function geocode(address) {
  const wait = lastGeocode + 1100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastGeocode = Date.now();
  const q = /santa monica/i.test(address) ? address : `${address}, Santa Monica, CA`;
  const [vb0, vb1, vb2, vb3] = SM.bbox;
  const hits = await getJson(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: "json", limit: "1", viewbox: `${vb0},${vb3},${vb2},${vb1}`, bounded: "1" })}`);
  if (!hits.length) throw new Error(`could not geocode "${address}" inside Santa Monica`);
  return { lon: +hits[0].lon, lat: +hits[0].lat, display: hits[0].display_name };
}
/** Query an ArcGIS REST layer by SQL where and/or by address (point-in-polygon, or within 250 m for point/line layers). */
export async function queryGis({ service_url, where = "", address = "", limit = 20 }) {
  if (!/^https:\/\/(gis\.santamonica\.gov|public\.gis\.lacounty\.gov|services\d*\.arcgis\.com|[\w.-]+\.arcgis\.com)\//.test(service_url)) throw new Error("service_url must be a gis.santamonica.gov / lacounty / arcgis.com REST layer");
  const info = await layerInfo(service_url);
  const params = { where: where || "1=1", outFields: "*", returnGeometry: "false", f: "json", resultRecordCount: String(Math.min(Math.max(1, limit), 100)) };
  let point = null;
  if (address) {
    point = await geocode(address);
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
const inBox = (lon, lat, [x0, y0, x1, y1] = SM.bbox) => lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1;

export const live = {
  weather: async () => {
    const [fc, al] = await Promise.all([getJson("https://api.weather.gov/gridpoints/LOX/146,45/forecast"), getJson("https://api.weather.gov/alerts/active?zone=CAZ366")]);
    return { source: "National Weather Service (api.weather.gov), Los Angeles County Coast zone CAZ366", url: "https://forecast.weather.gov/MapClick.php?lat=34.0195&lon=-118.4912",
      forecast: fc.properties.periods.slice(0, 8).map((p) => ({ period: p.name, temp: `${p.temperature}°${p.temperatureUnit}`, wind: `${p.windSpeed} ${p.windDirection}`, forecast: p.detailedForecast })),
      alerts: al.features.map((f) => ({ event: f.properties.event, severity: f.properties.severity, headline: f.properties.headline, ends: f.properties.ends, description: f.properties.description?.slice(0, 600) })) };
  },
  tides: async () => {
    const base = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9410840&units=english&time_zone=lst_ldt&format=json";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }).replace(/-/g, "");
    const [t, w] = await Promise.all([getJson(`${base}&product=predictions&datum=MLLW&interval=hilo&begin_date=${today}&range=48`), getJson(`${base}&product=water_temperature&date=latest`)]);
    return { source: "NOAA CO-OPS station 9410840 (Santa Monica Pier)", url: "https://tidesandcurrents.noaa.gov/stationhome.html?id=9410840",
      tides_next_48h: (t.predictions ?? []).map((p) => ({ time: p.t, height_ft: +p.v, type: p.type === "H" ? "high" : "low" })), water_temp_f: w.data?.[0] ? { time: w.data[0].t, value: +w.data[0].v } : null };
  },
  earthquakes: async () => {
    const j = await getJson(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${SM.lat}&longitude=${SM.lon}&maxradiuskm=60&minmagnitude=1.5&limit=15&orderby=time&starttime=${new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)}`);
    return { source: "USGS earthquake catalog, 60 km of Santa Monica, last 30 days", url: "https://earthquake.usgs.gov/earthquakes/map/",
      quakes: j.features.map((f) => ({ mag: f.properties.mag, place: f.properties.place, time: new Date(f.properties.time).toISOString(), depth_km: f.geometry.coordinates[2], url: f.properties.url })) };
  },
  air_quality: async () => {
    const j = await getJson(`https://airnowgovapi.com/reportingarea/get?latitude=${SM.lat}&longitude=${SM.lon}&stateCode=CA&maxDistance=50`);
    const rows = j.filter((r) => r.reportingArea === "NW Coastal LA" || r.isPrimary).map((r) => ({ type: { O: "observed", F: "forecast", Y: "yesterday" }[r.dataType] ?? r.dataType, date: r.validDate, time: r.time, parameter: r.parameter, aqi: r.aqi, category: r.category, site: r.siteName, area: r.reportingArea, action_day: r.isActionDay, discussion: r.discussion || undefined }));
    return { source: "AirNow (EPA / South Coast AQMD), NW Coastal LA reporting area", url: "https://www.airnow.gov/?city=Santa%20Monica&state=CA&country=USA", readings: rows };
  },
  beach_water_quality: async () => {
    const j = await getJson("https://admin.beachreportcard.org/api/locations/?county=Los%20Angeles"); // API ignores lat/lng; filter locally
    const near = j.map((x) => x._source).filter((s) => s?.active && s.geo?.[0]).map((s) => ({ km: +km(SM.lat, SM.lon, +s.geo[0], +s.geo[1]).toFixed(1), s })).filter((x) => x.km < 5).sort((a, b) => a.km - b.km)
      .map(({ km, s }) => ({ beach: s.title?.trim(), km_from_downtown: km, dry_weather_grade: s.dry_grade, wet_weather_grade: s.wet_grade, graded: s.grade_updated?.slice(0, 10), note: s.grade_note || undefined, annual: s.annual_year ? { year: s.annual_year, summer_dry: s.annual_summer_dry, winter_dry: s.annual_winter_dry, wet: s.annual_year_wet } : undefined, alerts: s.alerts?.length ? s.alerts : undefined, factors: s.factorsAffectingWater || undefined }));
    return { source: "Heal the Bay Beach Report Card (weekly grades; ns = not sampled)", url: "https://beachreportcard.org/", beaches: near };
  },
  scooters: async (near = "") => {
    const j = await getJson("https://data.lime.bike/api/partners/v2/gbfs/santa_monica/free_bike_status");
    const bikes = j.data.bikes.filter((b) => !b.is_disabled && !b.is_reserved);
    const out = { source: "Lime GBFS feed for Santa Monica (updated every minute)", url: "https://www.li.me/locations/santa-monica", available: Object.fromEntries(Object.entries(Object.groupBy(bikes, (b) => b.vehicle_type ?? b.vehicle_type_id)).map(([k, v]) => [k, v.length])), note: "Lime is the only operator publishing a public GBFS feed for Santa Monica today." };
    if (near) { const p = await geocode(near); out.nearest = bikes.map((b) => ({ type: b.vehicle_type, meters: Math.round(km(p.lat, p.lon, b.lat, b.lon) * 1000), range_km: Math.round((b.current_range_meters ?? 0) / 1000) })).sort((a, b) => a.meters - b.meters).slice(0, 5); out.near = p.display; }
    return out;
  },
  bus_alerts: async () => {
    const r = await fetch("https://gtfs.bigbluebus.com/alerts.bin", { headers: UA, signal: AbortSignal.timeout(15000) });
    return { source: "Big Blue Bus GTFS-Realtime service alerts", url: "https://www.bigbluebus.com/servicealerts", alerts: gtfsAlerts(Buffer.from(await r.arrayBuffer())) };
  },
  flights_over_airport: async () => {
    const j = await getJson("https://opensky-network.org/api/states/all?lamin=33.98&lomin=-118.55&lamax=34.06&lomax=-118.43");
    return { source: "OpenSky Network ADS-B, box around Santa Monica Airport (SMO)", url: "https://globe.adsbexchange.com/?lat=34.0158&lon=-118.4513&zoom=12", time: new Date(j.time * 1000).toISOString(),
      aircraft: (j.states ?? []).map((s) => ({ callsign: s[1]?.trim() || undefined, altitude_ft: s[7] != null ? Math.round(s[7] * 3.281) : (s[8] ? 0 : undefined), on_ground: s[8], speed_kt: s[9] != null ? Math.round(s[9] * 1.944) : undefined, heading: s[10] != null ? Math.round(s[10]) : undefined, lat: s[6], lon: s[5] })) };
  },
  traffic_cameras: async () => {
    const j = await getJson("https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json");
    return { source: "Caltrans District 7 CCTV", url: "https://cwwp2.dot.ca.gov/vm/iframemap.htm",
      cameras: j.data.map((x) => x.cctv).filter((c) => inBox(+c.location.longitude, +c.location.latitude, [-118.54, 33.99, -118.43, 34.06])).map((c) => ({ name: c.location.locationName, route: c.location.route, direction: c.location.direction, in_service: c.inService, image: c.imageData?.static?.currentImageURL })) };
  },
  health_stats: async () => {
    const j = await getJson("https://data.cdc.gov/resource/eav7-hnsx.json?locationname=Santa%20Monica&stateabbr=CA&datavaluetypeid=AgeAdjPrv&$select=year,category,measure,data_value,data_value_unit&$order=year%20DESC&$limit=200");
    const seen = new Set();
    return { source: "CDC PLACES: local health estimates, Santa Monica city (age-adjusted prevalence)", url: "https://www.cdc.gov/places/", measures: j.filter((r) => !seen.has(r.measure) && seen.add(r.measure)).map((r) => ({ year: r.year, category: r.category, measure: r.measure, value: `${r.data_value}${r.data_value_unit}` })) };
  },
  unemployment: async () => {
    const ids = { unemployment_rate_pct: "LAUCT067000000000003", unemployed: "LAUCT067000000000004", employed: "LAUCT067000000000005", labor_force: "LAUCT067000000000006" };
    const y = new Date().getFullYear(); // ponytail: unregistered BLS v2 rejects multi-series GETs, so 4 calls; cached a day (25 calls/day cap)
    const series = await Promise.all(Object.values(ids).map((id) => getJson(`https://api.bls.gov/publicAPI/v2/timeseries/data/${id}?startyear=${y - 1}&endyear=${y}`).then((j) => j.Results?.series?.[0]?.data ?? [])));
    return { source: "BLS Local Area Unemployment Statistics, Santa Monica city (not seasonally adjusted)", url: "https://data.bls.gov/timeseries/LAUCT067000000000003", series: Object.fromEntries(Object.keys(ids).map((k, i) => [k, series[i].slice(0, 13).map((d) => ({ period: `${d.year}-${d.period.slice(1)}`, value: +d.value, preliminary: d.footnotes?.some((f) => f.code === "P") || undefined }))])) };
  },
  wikipedia: async (query = "Santa Monica, California") => {
    const s = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(/santa monica/i.test(query) ? query : query + " Santa Monica")}&srlimit=4&format=json`);
    const titles = s.query.search.map((x) => x.title);
    if (!titles.length) return { source: "Wikipedia", results: [] };
    const e = await getJson(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(titles.join("|"))}&format=json`);
    return { source: "Wikipedia", results: Object.values(e.query.pages).map((p) => ({ title: p.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`, extract: p.extract?.slice(0, 1200) })) };
  },
  property: async (address) => {
    if (!address) throw new Error("property needs an address in query");
    // LA County Assessor roll, published as an ArcGIS table on the county hub (fields: SitusHouseNo, SitusStreet, SitusCity, UseType, YearBuilt, SQFTmain, Units, Roll_* values…)
    const ROLL = "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0";
    const m = address.match(/^\s*(\d+)\s+([NSEW]\.?\s+)?([^,#]+?)(?:\s+(?:apt|unit|#|ste|suite)\s*\S+)?(?:,|\s+santa monica|$)/i);
    if (!m) throw new Error("give a street address like '1685 Main St'");
    const street = m[3].trim().replace(/\s+(st|street|ave|avenue|blvd|boulevard|dr|drive|pl|place|ct|court|way|ter|terrace|ln|lane|rd|road)\.?$/i, "").toUpperCase().replace(/'/g, "''");
    const q = async (where) => (await getJson(`${ROLL}/query?${new URLSearchParams({ where, outFields: "*", returnGeometry: "false", resultRecordCount: "10", f: "json" })}`)).features?.map((f) => f.attributes) ?? [];
    let rows = await q(`SitusHouseNo = ${+m[1]} AND UPPER(SitusStreet) LIKE '${street}%' AND SitusCity LIKE 'SANTA MONICA%'`);
    if (!rows.length) { const p = await geocode(address); rows = await q(`CENTER_LAT BETWEEN ${p.lat - 0.0008} AND ${p.lat + 0.0008} AND CENTER_LON BETWEEN ${p.lon - 0.001} AND ${p.lon + 0.001}`); } // ~90 m box: public parcels often have a blank situs
    const keep = /^(AIN|AssessorID|PropertyLocation|UseType|UseCodeDescChar\d|YearBuilt|EffectiveYearBuilt|SQFTmain|Bedrooms|Bathrooms|Units|RecordingDate|Roll_LandValue|Roll_ImpValue|Roll_totLandImp|Roll_HomeOwnersExemp|Roll_TotalValue|netTaxableValue|isTaxableParcel|RollYear|SitusUnit|SitusZIP5)$/;
    return { source: "Los Angeles County Office of the Assessor, 2026 secured roll", url: rows[0] ? `https://portal.assessor.lacounty.gov/parceldetail/${rows[0].AIN}` : "https://portal.assessor.lacounty.gov/", note: "Public assessment record; values are assessed (Prop 13 base year + 2%/yr), not market.",
      parcels: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => keep.test(k) && v !== null && v !== "" && v !== 0))) };
  },
  ca_open_data: async (query = "Santa Monica") => {
    const j = await getJson(`https://data.ca.gov/api/3/action/package_search?q=${encodeURIComponent(query)}&rows=6`);
    return { source: "California Open Data Portal (data.ca.gov)", url: `https://data.ca.gov/dataset?q=${encodeURIComponent(query)}`, note: 'Query rows with query_dataset using portal="california" and a resource_id; filter on jurisdiction/city = "Santa Monica" where the dataset has such a field.',
      datasets: j.result.results.map((p) => ({ title: p.title, org: p.organization?.title, url: `https://data.ca.gov/dataset/${p.name}`, notes: strip(p.notes ?? "").slice(0, 300), resources: (p.resources ?? []).filter((r) => r.datastore_active).map((r) => ({ resource_id: r.id, name: r.name })) })) };
  },
  census: async () => {
    const key = process.env.CENSUS_API_KEY;
    const url = "https://data.census.gov/profile/Santa_Monica_city,_California?g=160XX00US0670000";
    if (!key) return { source: "US Census Bureau ACS", url, note: "CENSUS_API_KEY not set; point the resident to the profile page, or use the city's QL/SLE demographic datasets on data.santamonica.gov." };
    const vars = { population: "DP05_0001E", median_age: "DP05_0018E", median_household_income: "DP03_0062E", poverty_rate_pct: "DP03_0128PE", bachelors_or_higher_pct: "DP02_0068PE", foreign_born_pct: "DP02_0094PE", housing_units: "DP04_0001E", renter_occupied_pct: "DP04_0047PE", median_home_value: "DP04_0089E", median_gross_rent: "DP04_0134E", commute_public_transit_pct: "DP03_0021PE", work_from_home_pct: "DP03_0024PE" };
    const [h, r] = await getJson(`https://api.census.gov/data/2023/acs/acs5/profile?get=${Object.values(vars).join(",")}&for=place:70000&in=state:06&key=${key}`);
    return { source: "US Census Bureau, ACS 5-year 2019–2023, Santa Monica city", url, values: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, +r[h.indexOf(v)]])) };
  },
};
export const LIVE_KINDS = Object.keys(live);
const TTL = { unemployment: 864e5, health_stats: 864e5, census: 864e5, wikipedia: 3600e3, property: 3600e3, ca_open_data: 3600e3, scooters: 60e3, flights_over_airport: 60e3 };
export const liveData = (kind, query = "") => {
  if (!live[kind]) throw new Error(`unknown kind; one of ${LIVE_KINDS.join(", ")}`);
  return cached(`${kind}|${query}`, TTL[kind] ?? 300e3, () => live[kind](query));
};
export const LIVE_HELP = {
  weather: "7-day NWS forecast + active alerts (heat, wind, surf, flood) for the Santa Monica coast",
  tides: "next 48 h high/low tides and ocean water temperature at Santa Monica Pier",
  earthquakes: "earthquakes within 60 km in the last 30 days",
  air_quality: "current and forecast AQI (ozone, PM2.5, PM10) for NW Coastal LA",
  beach_water_quality: "Heal the Bay grades for every Santa Monica beach monitoring site",
  scooters: "Lime e-scooters/e-bikes available right now; query = address to get the nearest ones",
  bus_alerts: "Big Blue Bus detours, stop closures and service alerts right now",
  flights_over_airport: "aircraft currently over/around Santa Monica Airport (noise questions)",
  traffic_cameras: "Caltrans live camera images on I-10 and PCH in Santa Monica",
  health_stats: "CDC PLACES health prevalence estimates for Santa Monica (asthma, obesity, insurance, etc.)",
  unemployment: "BLS monthly unemployment rate, labor force, employment for the city",
  wikipedia: "encyclopedia background on a Santa Monica place, person or history topic; query = topic",
  property: "LA County Assessor record for a Santa Monica parcel: use, year built, sq ft, units, assessed values; query = street address",
  ca_open_data: "find California state datasets (housing element progress, EDD, DOJ, etc.) to query with query_dataset portal=california; query = keywords",
  census: "ACS 5-year demographic profile for Santa Monica city (needs CENSUS_API_KEY)",
};
