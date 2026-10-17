import { FORM_TYPES } from "./forms.js";
// Jurisdiction registry: every city/county the assistant serves, with the ids every ingester, tool and prompt reads.
// Santa Monica is fully wired. Other entries start as `draft: true` (name, aliases, centroid, site) and get their
// portals / council / youtube / feeds / live ids filled by discover.js + a human. Null fields degrade gracefully.
import fs from "node:fs";

import { LA_CITIES } from "./jurisdictions-la.js";
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const SANTA_MONICA = {
  id: "santa-monica", name: "City of Santa Monica", short: "Santa Monica", kind: "city", county: "los-angeles-county", prefix: "SM",
  aliases: ["santa monica", "ocean park", "sunset park", "pico neighborhood", "north of montana", "wilmont", "downtown santa monica", "santa monica pier", "smc", "smmusd", "big blue bus"],
  zips: ["90401", "90402", "90403", "90404", "90405"],
  center: [34.0195, -118.4912], bbox: [-118.5176, 33.9950, -118.4432, 34.0506],
  site: "https://www.santamonica.gov", icon: "https://www.santamonica.gov/SantaMonica.Gov.Theme/Icons/favicon/apple-icon-180x180.png",
  domains: ["santamonica.gov", "permits.santamonica.gov", "data.santamonica.gov", "filmsantamonica.com", "bigbluebus.com", "smpl.org", "smgov.net", "santamonicapd.org", "santamonicacityca.iqm2.com", "santamonica.granicus.com",
    "smdp.com", "smmirror.com", "santamonicanext.org", "surfsantamonica.com", "smobserved.com", "westsidecurrent.com", "thecorsaironline.com", "smc.edu", "smmusd.org", "downtownsm.com", "santamonicapier.org", "santamonica.com", "healthebay.org"],
  contact: { name: "Santa Monica 311", phone: "(310) 458-8411", email: "311@santamonica.gov", line: "311 or (310) 458-8411" },
  portals: [{ id: "santamonica", type: "ckan", url: "https://data.santamonica.gov/api/3/action", site: "https://data.santamonica.gov" }],
  council: { platform: "ckan-iqm2", portal: "santamonica", resource: "40013cb9-7b56-4059-a7eb-5de5a26f8bac", agency: "City Council", label: "City Council", limit: 1000, since: "2015" },
  youtube: ["UC4V0jOEL4JMCcElkGA7AJpA", "UC8x0GS29SP-IbeiLRxMNlaw", "UCrlsaKRGJhbvnJbvRpQWykA"], // City of Santa Monica (2017→), Meeting Coverage (2015–17), SMUpdateCityTV16 (2014)
  feeds: null, // Santa Monica feeds are the FEEDS list in sources.js (feedsFor)
  gis: [{ org: "City of Santa Monica GIS", url: "https://gis-smgov.opendata.arcgis.com/api/feed/dcat-us/1.1.json" }], gisHosts: ["gis.santamonica.gov"],
  live: {
    nws: "LOX/146,45", nwsZone: "CAZ366", nwsName: "Los Angeles County Coast zone CAZ366",
    tide: "9410840", tideName: "Santa Monica Pier",
    airnowArea: "NW Coastal LA",
    gbfs: { url: "https://data.lime.bike/api/partners/v2/gbfs/santa_monica/free_bike_status", site: "https://www.li.me/locations/santa-monica", note: "Lime is the only operator publishing a public GBFS feed for Santa Monica today." },
    gtfsrt: { name: "Big Blue Bus", url: "https://gtfs.bigbluebus.com/alerts.bin", site: "https://www.bigbluebus.com/servicealerts" },
    airport: { name: "Santa Monica Airport (SMO)", box: [-118.55, 33.98, -118.43, 34.06], globe: "https://globe.adsbexchange.com/?lat=34.0158&lon=-118.4513&zoom=12" },
    caltrans: "07", camsBox: [-118.54, 33.99, -118.43, 34.06], camsName: "I-10 and PCH",
    placesName: "Santa Monica", censusPlace: "70000", censusName: "Santa_Monica_city,_California",
  },
  forms: ["block_party_permit", "preferential_parking_permit", "bulky_item_pickup", "business_license", "dog_license", "community_event_permit", "311_service_request"],
  routing: {
    building_permit: ["Building & Safety, Permit Services Center", "Plan check assignment within 2 business days; simple trade permits often issue same day."],
    business_license: ["Finance, Business License Office", "Review within 5 business days; you'll receive a tax bill before the license issues."],
    community_event_permit: ["Community Services, Community Events Office", "Staff review within 10 business days; large events may need Police, Fire and Public Works sign-off."],
    block_party_permit: ["Transportation Planning (Mobility Division)", "Departments review the request; once approved you'll be emailed to pay the $100.95 fee and download the permit. Pick up signs and barricades at City Yards, 2500 Michigan Ave, and give neighbors 3–5 days' notice."],
    film_permit: ["Film Santa Monica", "Review within 5 business days; a location fee and insurance certificate will be requested."],
    encroachment_permit: ["Public Works, Engineering", "Review within 5 business days; traffic control plan may be required."],
    preferential_parking_permit: ["Finance, Parking Permits", "Proof of residency verified within 3 business days; permit mailed or available for pickup."],
    temporary_use_permit: ["Planning Division", "Review within 10 business days."],
    sidewalk_vending_permit: ["Finance / Code Enforcement", "Review within 10 business days; county health permit required for food."],
    home_share_license: ["Finance, Business License Office", "Review within 10 business days; host must reside on site."],
    dog_license: ["Santa Monica Animal Shelter (Animal Services)", "Issued within 5 business days once the rabies certificate is verified; the tag is mailed to you."],
    alarm_permit: ["SMPD Alarm Unit", "Issued within 5 business days."],
    bulky_item_pickup: ["Public Works, Resource Recovery & Recycling", "Collection within 7–10 days; set items at the curb the night before."],
    "311_service_request": ["Santa Monica 311", "Routed to the responsible division; most requests acknowledged within 2 business days."],
    other: ["Santa Monica 311", "311 staff will route to the correct department within 2 business days."],
  },
};

const LA_COUNTY = {
  id: "los-angeles-county", name: "County of Los Angeles", short: "LA County", kind: "county", county: null, prefix: "LAC", draft: true, // served: BOS (Legistar) + eGIS + data.lacounty.gov collected 2026-10-17 // served (county government + unincorporated areas); also context for every LA County city
  aliases: ["los angeles county", "la county", "county of los angeles", "la county board of supervisors", "unincorporated los angeles", "marina del rey", "altadena", "east los angeles", "east la", "ladera heights", "view park", "windsor hills", "topanga", "stevenson ranch", "castaic", "rowland heights", "hacienda heights", "florence-firestone", "willowbrook", "lennox", "west athens", "acton", "agua dulce", "quartz hill", "lake los angeles", "littlerock", "valinda", "south whittier", "west whittier", "walnut park", "la crescenta", "universal city", "west carson", "del aire", "west rancho dominguez", "charter oak", "covina hills"], center: [34.05, -118.25], bbox: null,
  site: "https://lacounty.gov", icon: null,
  domains: ["lacounty.gov", "lavote.gov", "lahsa.org", "assessor.lacounty.gov", "publichealth.lacounty.gov", "metro.net"],
  contact: { name: "LA County 211", phone: "211", email: "", line: "211" },
  portals: [{ id: "lacounty", type: "dcat", url: "https://data.lacounty.gov/data.json", site: "https://data.lacounty.gov" }], council: { platform: "legistar", client: "lacounty", body: "Board of Supervisors", label: "Board of Supervisors", limit: 500 }, youtube: [], feeds: [], // Legistar holds only 2022-> BOS meetings; bos.lacounty.gov (Kontent SPA) + Statement of Proceedings are the fuller record - pdflist/SOP adapter pending
  gis: [{ org: "LA County eGIS", url: "https://egis-lacounty.hub.arcgis.com/api/feed/dcat-us/1.1.json" }], gisHosts: ["public.gis.lacounty.gov"],
  gisExtra: [ // political boundaries: "who represents this address"
    [27, "Supervisorial District (Current)", "county supervisor board of supervisors"], [29, "Congressional District (2021)", "congress congressman congresswoman house representative"],
    [30, "State Assembly District (2021)", "assemblymember state assembly"], [31, "State Senate District (2021)", "state senator"],
  ].map(([id, name, syn]) => ({ title: `LA County ${name}`, url: "https://egis-lacounty.hub.arcgis.com/", service: `https://public.gis.lacounty.gov/public/rest/services/LACounty_Dynamic/Political_Boundaries/MapServer/${id}`, notes: `Which ${name.replace(/ \(.*\)/, "")} an address falls in (${syn}). Query with an address.`, keywords: ["district", "representative", "elected", "who represents me", "my", ...syn.split(" ")] })),
  live: { beachCounty: "Los Angeles", assessor: { url: "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0", portal: "https://portal.assessor.lacounty.gov", name: "Los Angeles County Office of the Assessor, 2026 secured roll" } },
  forms: [], routing: {},
};

const CALIFORNIA = {
  id: "california", name: "State of California", short: "California", kind: "state", county: null, prefix: "CA", context: true,
  aliases: [], center: null, bbox: null, site: "https://www.ca.gov", icon: null, domains: ["ca.gov"],
  portals: [{ id: "california", type: "ckan", url: "https://data.ca.gov/api/3/action", site: "https://data.ca.gov", index: false }], // query-only (query_dataset portal=california); not indexed
  council: null, youtube: [], feeds: [], gis: [], live: {}, forms: [], routing: {},
};

// County governments the user asked for. Verified 2026-10-17: sdcounty Legistar Web API answers without a token;
// board.oc.gov is a custom archive (HTML); OC Public Works publishes on ArcGIS Hub.
const SD_COUNTY = {
  id: "san-diego-county", name: "County of San Diego", short: "San Diego County", kind: "county", county: null, prefix: "SDC", draft: true,
  aliases: ["san diego county", "county of san diego", "sd county", "unincorporated san diego"], center: [32.75, -116.8], bbox: [-117.6, 32.53, -116.08, 33.51],
  site: "https://www.sandiegocounty.gov", icon: null, domains: ["sandiegocounty.gov", "sdcounty.legistar.com", "sandag.org", "sangis.org", "sdcoe.net", "voiceofsandiego.org", "kpbs.org", "inewsource.org", "timesofsandiego.com"],
  contact: { name: "County of San Diego", phone: "(619) 531-5434", email: "", line: "(619) 531-5434 (Clerk of the Board)" },
  portals: [{ id: "sandag", type: "dcat", url: "https://opendata.sandag.org/data.json", site: "https://opendata.sandag.org" }], // regional (SANDAG, Socrata): crime, transportation, demographics for the whole county
  council: { platform: "legistar", client: "sdcounty", body: "BOARD OF SUPERVISORS", label: "Board of Supervisors", limit: 200 },
  youtube: [], feeds: [{ id: "gn", name: "Google News", url: gnews('"San Diego County" supervisors OR county when:30d') }],
  gis: [], gisHosts: [], live: { beachCounty: "San Diego", caltrans: "11", tide: "9410170", tideName: "La Jolla (Scripps Pier)" },
  forms: [], routing: {},
};
const OC_COUNTY = {
  id: "orange-county", name: "County of Orange", short: "Orange County", kind: "county", county: null, prefix: "OC", draft: true,
  aliases: ["orange county", "county of orange", "oc board of supervisors", "oc supervisors", "unincorporated orange county"], center: [33.70, -117.78], bbox: [-118.13, 33.35, -117.41, 33.95],
  site: "https://www.ocgov.com", icon: null, domains: ["ocgov.com", "oc.gov", "board.oc.gov", "ceo.oc.gov", "ocpublicworks.com", "voiceofoc.org", "octa.net", "ocvote.gov"],
  contact: { name: "County of Orange", phone: "(714) 834-2206", email: "", line: "(714) 834-2206 (Clerk of the Board)" },
  portals: [{ id: "ocpw", type: "dcat", url: "https://data-ocpw.opendata.arcgis.com/api/feed/dcat-us/1.1.json", site: "https://data-ocpw.opendata.arcgis.com" }],
  council: { platform: "ocboard", url: "https://board.oc.gov", label: "Board of Supervisors", limit: 200 },
  youtube: [], feeds: [{ id: "gn", name: "Google News", url: gnews('"Orange County" supervisors OR "county of orange" when:30d') }, { id: "voc", name: "Voice of OC", url: "https://voiceofoc.org/feed/" }],
  gis: [{ org: "OC Public Works", url: "https://data-ocpw.opendata.arcgis.com/api/feed/dcat-us/1.1.json" }], gisHosts: [], live: { beachCounty: "Orange", caltrans: "12", tide: "9410580", tideName: "Newport Beach" },
  forms: [], routing: {},
};

// Cities: name, site (from memory; discover.js verifies), centroid, extra aliases. Everything else is filled per phase.
// Main phone numbers collected from each city's own site by `node phones.js` (data/phones.json: {id: {phone, url}}).
const PHONES = (() => { try { return JSON.parse(fs.readFileSync("./data/phones.json", "utf8")); } catch { return {}; } })();
const city = (id, name, county, site, center, aliases = [], extra = {}) => ({
  id, name: `City of ${name}`, short: name, kind: "city", county, prefix: id.replace(/-/g, "").slice(0, 3).toUpperCase(), draft: true,
  aliases: [name.toLowerCase(), ...aliases], zips: [], center, bbox: null,
  site, icon: null, domains: [site.replace(/^https?:\/\/(www\.)?/, "")],
  contact: { name: `City of ${name}`, phone: PHONES[id]?.phone ?? "", email: "", line: PHONES[id]?.phone ? `${PHONES[id].phone} (City Hall main line)` : `the city's main line (see ${site})` },
  portals: [], council: null, youtube: [], feeds: [{ id: "gn", name: "Google News", url: gnews(`"${name}" california when:30d`) }], gis: [], gisHosts: [], live: {}, forms: [], routing: {},
  ...extra,
});
const SD = "san-diego-county", OC = "orange-county", LA = "los-angeles-county";
const CITIES = [
  // San Diego County (18)
  city("carlsbad", "Carlsbad", SD, "https://www.carlsbadca.gov", [33.158, -117.351]),
  city("chula-vista", "Chula Vista", SD, "https://www.chulavistaca.gov", [32.640, -117.084]),
  city("coronado", "Coronado", SD, "https://www.coronado.ca.us", [32.686, -117.183]),
  city("del-mar", "Del Mar", SD, "https://www.delmar.ca.us", [32.959, -117.265]),
  city("el-cajon", "El Cajon", SD, "https://www.elcajon.gov", [32.795, -116.963]),
  city("encinitas", "Encinitas", SD, "https://www.encinitasca.gov", [33.037, -117.292], ["cardiff by the sea", "leucadia", "olivenhain"]),
  city("escondido", "Escondido", SD, "https://www.escondido.gov", [33.119, -117.086]),
  city("imperial-beach", "Imperial Beach", SD, "https://www.imperialbeachca.gov", [32.584, -117.113]),
  city("la-mesa", "La Mesa", SD, "https://www.cityoflamesa.us", [32.768, -117.023]),
  city("lemon-grove", "Lemon Grove", SD, "https://www.lemongrove.ca.gov", [32.743, -117.031]),
  city("national-city", "National City", SD, "https://www.nationalcityca.gov", [32.678, -117.099]),
  city("oceanside", "Oceanside", SD, "https://www.ci.oceanside.ca.us", [33.196, -117.379]),
  city("poway", "Poway", SD, "https://poway.org", [32.963, -117.036]),
  city("san-diego", "San Diego", SD, "https://www.sandiego.gov", [32.716, -117.161], ["la jolla", "hillcrest", "north park", "mission valley", "rancho bernardo", "otay mesa", "san ysidro", "pacific beach", "ocean beach", "point loma", "clairemont", "mira mesa", "downtown san diego", "gaslamp"],
    { prefix: "SD", icon: "https://www.sandiego.gov/sites/default/files/favicon.ico", domains: ["sandiego.gov", "data.sandiego.gov", "sandiego.hylandcloud.com", "sdmts.com", "voiceofsandiego.org", "kpbs.org", "timesofsandiego.com"],
      contact: { name: "City of San Diego - Get It Done", phone: "(619) 236-5555", email: "", line: "(619) 236-5555 or the Get It Done app" },
      portals: [{ id: "sandiego", type: "dcat", url: "https://raw.githubusercontent.com/COSD-PANDA/data-inventory/refs/heads/master/data.json", site: "https://data.sandiego.gov", datasetUrl: "https://data.sandiego.gov/datasets/" }],
      council: { platform: "hyland", url: "https://sandiego.hylandcloud.com/211agendaonlinecouncil", docket: "https://www.sandiego.gov/city-clerk/city-council-docket-agenda", label: "City Council", limit: 200 },
      live: { caltrans: "11", tide: "9410170", tideName: "La Jolla (Scripps Pier)", airport: { name: "San Diego International (SAN)", box: [-117.25, 32.70, -117.15, 32.76], globe: "https://globe.adsbexchange.com/?lat=32.7336&lon=-117.1897&zoom=12" }, placesName: "San Diego", censusPlace: "66000", censusName: "San_Diego_city,_California" } }),
  city("san-marcos", "San Marcos", SD, "https://www.san-marcos.net", [33.143, -117.166]),
  city("santee", "Santee", SD, "https://www.cityofsanteeca.gov", [32.838, -116.974]),
  city("solana-beach", "Solana Beach", SD, "https://www.cityofsolanabeach.org", [32.991, -117.271]),
  city("vista", "Vista", SD, "https://www.cityofvista.com", [33.200, -117.243]),
  // Orange County (34)
  city("aliso-viejo", "Aliso Viejo", OC, "https://www.avcity.org", [33.575, -117.726]),
  city("anaheim", "Anaheim", OC, "https://www.anaheim.net", [33.836, -117.914], ["anaheim hills", "platinum triangle", "disneyland"], { live: { caltrans: "12", placesName: "Anaheim", censusPlace: "02000", censusName: "Anaheim_city,_California" } }),
  city("brea", "Brea", OC, "https://www.ci.brea.ca.us", [33.917, -117.900]),
  city("buena-park", "Buena Park", OC, "https://www.buenapark.com", [33.868, -117.998]),
  city("costa-mesa", "Costa Mesa", OC, "https://www.costamesaca.gov", [33.641, -117.919]),
  city("cypress", "Cypress", OC, "https://www.cypressca.org", [33.817, -118.037]),
  city("dana-point", "Dana Point", OC, "https://www.danapoint.org", [33.467, -117.698]),
  city("fountain-valley", "Fountain Valley", OC, "https://www.fountainvalley.gov", [33.709, -117.954]),
  city("fullerton", "Fullerton", OC, "https://www.cityoffullerton.com", [33.870, -117.925]),
  city("garden-grove", "Garden Grove", OC, "https://ggcity.org", [33.774, -117.938]),
  city("huntington-beach", "Huntington Beach", OC, "https://www.huntingtonbeachca.gov", [33.660, -117.999], ["surf city"]),
  city("irvine", "Irvine", OC, "https://www.cityofirvine.org", [33.684, -117.826], ["great park", "woodbridge", "uci", "irvine spectrum"], { live: { caltrans: "12", placesName: "Irvine", censusPlace: "36770", censusName: "Irvine_city,_California" } }),
  city("la-habra", "La Habra", OC, "https://www.lahabraca.gov", [33.932, -117.946]),
  city("la-palma", "La Palma", OC, "https://www.cityoflapalma.org", [33.846, -118.047]),
  city("laguna-beach", "Laguna Beach", OC, "https://www.lagunabeachcity.net", [33.542, -117.783]),
  city("laguna-hills", "Laguna Hills", OC, "https://www.lagunahillsca.gov", [33.600, -117.700]),
  city("laguna-niguel", "Laguna Niguel", OC, "https://www.cityoflagunaniguel.org", [33.523, -117.708]),
  city("laguna-woods", "Laguna Woods", OC, "https://www.cityoflagunawoods.org", [33.610, -117.729]),
  city("lake-forest", "Lake Forest", OC, "https://www.lakeforestca.gov", [33.647, -117.689]),
  city("los-alamitos", "Los Alamitos", OC, "https://cityoflosalamitos.org", [33.803, -118.073]),
  city("mission-viejo", "Mission Viejo", OC, "https://cityofmissionviejo.org", [33.600, -117.672]),
  city("newport-beach", "Newport Beach", OC, "https://www.newportbeachca.gov", [33.619, -117.929], ["balboa island", "corona del mar"]),
  city("orange", "Orange", OC, "https://www.cityoforange.org", [33.788, -117.853], ["city of orange", "orange, ca", "orange ca", "old towne orange"]),
  city("placentia", "Placentia", OC, "https://www.placentia.org", [33.872, -117.870]),
  city("rancho-santa-margarita", "Rancho Santa Margarita", OC, "https://www.cityofrsm.org", [33.641, -117.603], ["rsm"]),
  city("san-clemente", "San Clemente", OC, "https://www.san-clemente.org", [33.427, -117.612]),
  city("san-juan-capistrano", "San Juan Capistrano", OC, "https://sanjuancapistrano.org", [33.502, -117.663]),
  city("santa-ana", "Santa Ana", OC, "https://www.santa-ana.org", [33.746, -117.868]),
  city("seal-beach", "Seal Beach", OC, "https://www.sealbeachca.gov", [33.741, -118.105]),
  city("stanton", "Stanton", OC, "https://www.stantonca.gov", [33.803, -117.993]),
  city("tustin", "Tustin", OC, "https://www.tustinca.org", [33.746, -117.826]),
  city("villa-park", "Villa Park", OC, "https://www.villapark.org", [33.814, -117.813]),
  city("westminster", "Westminster", OC, "https://www.westminster-ca.gov", [33.751, -117.994], ["little saigon"]),
  city("yorba-linda", "Yorba Linda", OC, "https://www.yorbalindaca.gov", [33.889, -117.813]),
];
// "Orange" the city must never match the bare word (Orange County, orange cones): only its explicit aliases.
CITIES.find((c) => c.id === "orange").aliases = ["city of orange", "orange, ca", "orange ca", "old towne orange", "orange city council"];
// Same for LA County cities whose names are ordinary words: never match the bare word.

export const JURS = [SANTA_MONICA, LA_COUNTY, CALIFORNIA, SD_COUNTY, OC_COUNTY, ...LA_CITIES, ...CITIES];
// Auto-discovered sources (node discover.js + node apply-discover.js -> data/discovered.json) fill fields a draft
// entry leaves empty. Hand-written registry values always win.
{
  let found = {}; try { found = JSON.parse(fs.readFileSync("./data/discovered.json", "utf8")); } catch {}
  for (const j of JURS) {
    const d = found[j.id]; if (!d || !j.draft) continue;
    if (!j.council && d.council) j.council = d.council;
    if (!j.youtube?.length && d.youtube?.length) j.youtube = d.youtube;
    if (!j.gis?.length && d.gis?.length) { j.gis = d.gis; j.gisHosts = [...new Set([...(j.gisHosts ?? []), ...(d.gisHosts ?? [])])]; }
  }
}
const byId = new Map(JURS.map((j) => [j.id, j]));
export const jurById = (id) => byId.get(id) ?? null;
export const SERVED = JURS.filter((j) => !j.context); // what the assistant answers for (counties + cities)
export const countyOf = (j) => (j?.county ? byId.get(j.county) : null);
/** Retrieval scope for a jurisdiction: itself, its county, the state. */
export const scopeIds = (j) => (j ? [j.id, j.county, "california"].filter(Boolean) : null);
export const dataDir = (j) => `./data/${j.id}`;

// Detection: longest alias wins ("san diego county" beats "san diego"); exactly one jurisdiction → its id, else null.
const ALIASES = JURS.filter((j) => !j.context).flatMap((j) => [...j.aliases, ...(j.zips ?? [])].map((a) => [a.toLowerCase(), j.id])).sort((a, b) => b[0].length - a[0].length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALIAS_RE = new RegExp(`(?<![a-z0-9])(${ALIASES.map(([a]) => esc(a)).join("|")})(?![a-z0-9])`, "gi");
const ALIAS_ID = new Map(ALIASES);
export function detect(text) {
  const found = new Set();
  for (const m of String(text).toLowerCase().matchAll(ALIAS_RE)) found.add(ALIAS_ID.get(m[1]));
  if (/\bOC\b/.test(text) && !found.size) found.add("orange-county");
  return found.size === 1 ? [...found][0] : null;
}
export const containsPoint = (j, lon, lat) => !!j.bbox && lon >= j.bbox[0] && lon <= j.bbox[2] && lat >= j.bbox[1] && lat <= j.bbox[3];
/** Nearest served jurisdiction to a point: bbox hit first, else closest centroid within ~25 km. */
export function nearest(lon, lat) {
  const hit = SERVED.find((j) => j.kind === "city" && containsPoint(j, lon, lat));
  if (hit) return hit;
  let best = null, bd = Infinity; // ponytail: nearest centroid within 12 km stands in for city limits until bboxes are filled by discover.js
  for (const j of SERVED) if (j.center && j.kind === "city") { const d = Math.hypot((j.center[1] - lon) * 92, (j.center[0] - lat) * 111); if (d < bd) { bd = d; best = j; } }
  return bd < 12 ? best : SERVED.find((j) => j.kind === "county" && containsPoint(j, lon, lat)) ?? null;
}

/** Per-turn system block describing the active jurisdiction to the model (what exists, what doesn't). */
export function contextFor(j, { catalogSummary = "", councilStatus = "", via = "" } = {}) {
  if (!j) return `No jurisdiction is set yet. Covered: Santa Monica; every city in San Diego County and Orange County; the County of San Diego and the County of Orange. If the question depends on where the resident is, ask one short question ("Which city are you in? An address works too.") and call no search tools until it is set. Call set_jurisdiction as soon as you know.`;
  const county = countyOf(j);
  const lines = [
    `Active jurisdiction: ${j.name} (${j.kind}${county ? `, ${county.name}` : ""}). Website: ${j.site}. Contact for anything you can't verify: ${j.contact?.line ?? "the city's main line"}.`,
    via === "location" ? `The resident's device location is available: tools that take an address use it automatically when the address is empty. This jurisdiction was inferred from the resident's device location, not from anything they said. Answer for ${j.short} without asking; the first time a place matters, say in a few words that you're assuming ${j.short} and that they can name another city.` : "",
    j.draft ? `Data wiring for ${j.short} is partial beyond what is listed below. web_search is open: search "${j.short}" plus the service (e.g. "${j.short} bulky item pickup"), prefer the city's site ${j.domains[0]} and its contracted providers (trash hauler, permit portal, transit agency, county), read the page with web_fetch, and answer with the actual rules, fees, limits and phone numbers you find. Say only what could not be verified after searching.` : "",
    j.council ? `Council/board records: ${j.council.label} via ${j.council.platform}${councilStatus ? ` (${councilStatus})` : ""}.` : `No council/board records are indexed for ${j.short}; use web_search on its site for meetings.`,
    `Guided application cards available here: ${(j.forms?.length ? j.forms : FORM_TYPES).join(", ")}${j.forms?.length ? "" : ` (generic cards: they collect the common fields and ${j.short} confirms fees and documents on review)`}.`,
    Object.keys(j.live ?? {}).length ? `Live data configured: ${Object.keys(j.live).join(", ")} (weather, earthquakes, air quality, wikipedia work everywhere).` : "Live data: weather, earthquakes, air quality, wikipedia only.",
    catalogSummary ? `Open datasets available for ${j.short} (search_city_knowledge finds the right one and its fields):\n${catalogSummary}` : `No open-data catalog indexed for ${j.short}.`,
  ];
  return lines.filter(Boolean).join("\n");
}
