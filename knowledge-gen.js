// Draft knowledge/<jurisdiction>/*.md for a city or county from its own website, in the same format as the Santa Monica files
// (## sections, each ending with "Source: <url>"), so rag.js indexes them identically. Maintainer script; needs ANTHROPIC_API_KEY.
//   node knowledge-gen.js irvine           # one jurisdiction
//   node knowledge-gen.js --all            # every draft jurisdiction without a knowledge folder
// Pages come from the site's sitemap(s) filtered by topic keywords (capped per topic); the model is asked to write only what the
// pages say, with fees/hours/phones verbatim, and to drop anything it cannot source. Review the output; it ships as-is.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { SERVED, jurById } from "./jurisdictions.js";

try { process.loadEnvFile(); } catch {}
const client = new Anthropic();
const MODEL = process.env.KNOWLEDGE_MODEL || "claude-sonnet-5-5";
// Browser-like headers: several city sites (Akamai/Cloudflare fronted) 403 a bare UA. Sites that still block get the web-tools pass below.
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" };
const TOPICS = {
  "city-services-az": ["library", "parks", "recreation", "trash", "recycl", "waste", "bulky", "street-sweep", "water", "utilit", "311", "report", "animal", "senior", "youth", "events", "contact", "hours", "department"],
  "permits-howto": ["permit", "building", "planning", "zoning", "adu", "business-licen", "business-tax", "film", "special-event", "block-party", "encroach", "inspection", "fee"],
  "housing-rent-control": ["housing", "rent", "tenant", "landlord", "affordable", "homeless", "eviction", "section-8"],
  "public-safety-code": ["police", "fire", "code-enforcement", "noise", "nuisance", "emergency", "alert", "evacuation", "disaster"],
  "transportation-parking": ["parking", "transit", "bus", "bike", "traffic", "street", "sidewalk", "shuttle", "ev-charg"],
  "basics": ["about", "council", "mayor", "city-hall", "city-manager", "clerk", "elections", "budget", "meetings", "agenda"],
};
const PER_TOPIC = Number(process.env.KNOWLEDGE_PAGES) || 14, MAX_CHARS = 9000;
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, " ").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
async function text(url, t = 20000) { try { const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(t) }); return r.ok ? await r.text() : ""; } catch { return ""; } }
async function sitemapUrls(site) {
  const seen = new Set(), queue = [`${site}/sitemap.xml`, `${site}/sitemap_index.xml`, `${site}/sitemap-index.xml`];
  const urls = [];
  while (queue.length && seen.size < 20) {
    const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
    const xml = await text(u); if (!xml) continue;
    for (const [, loc] of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) (/sitemap[^/]*\.xml/i.test(loc) ? queue : urls).push(loc);
  }
  return [...new Set(urls)];
}
// No sitemap: crawl the home page and its same-host links two levels deep (keyword-matching links only at level 2). ponytail: serial, capped at 1500 urls
async function crawlUrls(site) {
  const host = new URL(site).host, seen = new Set([site]), out = [];
  const links = (base, html) => [...html.matchAll(/href=["']([^"'#?]+)/gi)].map(([, h]) => { try { return new URL(h, base).href.replace(/\/$/, ""); } catch { return null; } }).filter((u) => u && new URL(u).host === host && !/\.(pdf|jpg|png|gif|css|js|xml|ico|svg|mp4|zip)$/i.test(u));
  const home = links(site, await text(site));
  for (const u of home) if (!seen.has(u)) { seen.add(u); out.push(u); }
  const keys = Object.values(TOPICS).flat();
  for (const u of out.slice(0, 120)) { if (out.length > 1500) break; for (const v of links(u, await text(u))) if (!seen.has(v) && keys.some((k) => v.toLowerCase().includes(k))) { seen.add(v); out.push(v); } }
  return out;
}
const EXAMPLE = fs.readFileSync("./knowledge/santa-monica/public-safety-code.md", "utf8").split("\n").slice(0, 14).join("\n");

async function generate(j) {
  const dir = `./knowledge/${j.id}`;
  let all = await sitemapUrls(j.site), how = "sitemap";
  if (!all.length) { all = await crawlUrls(j.site); how = "crawled"; }
  console.log(`${j.id}: ${all.length} ${how} urls`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [topic, keys] of Object.entries(TOPICS)) {
    if (fs.existsSync(`${dir}/${topic}.md`)) continue; // resumable: rerun a jurisdiction to fill only the missing topics
    // Round-robin over keywords so every theme gets pages (first-match-wins let "department"/"contact" crowd out trash/bulky pages)
    const picked = []; for (let round = 0; picked.length < PER_TOPIC && round < PER_TOPIC; round++) for (const k of keys) { const u = all.find((x) => x.toLowerCase().includes(k) && !picked.includes(x)); if (u && picked.length < PER_TOPIC) picked.push(u); }
    if (!all.length) picked.push(...keys.slice(0, 6).map((k) => `${j.site}/${k}`)); // no sitemap: try guessed paths
    const pages = [];
    for (const u of picked) { const t = strip(await text(u)); if (t.length > 400) pages.push({ url: u, text: t.slice(0, MAX_CHARS) }); }
    const system = `You write a local-government knowledge file for ${j.name}, California, for a retrieval index. Output Markdown only, in exactly this format (title line, then "## " sections, each 1-3 short paragraphs of concrete facts followed by a "Source: <url>" line using the page the facts came from):\n\n${EXAMPLE}\n\nRules: only facts stated on the pages given; copy fees, hours, phone numbers, addresses and deadlines verbatim; never guess or generalise; skip a page that has no resident-facing facts; one section per distinct service or process; no preamble, no closing notes.`;
    // Site unreachable from here (403s, no sitemap, no crawlable links): let the model search and fetch the site itself (same tools server.js uses)
    const host = new URL(j.site).host.replace(/^www\./, "");
    let res; try { res = pages.length ? await client.messages.create({
      model: MODEL, max_tokens: 6000, system,
      messages: [{ role: "user", content: `Topic file: ${topic}. Pages:\n\n${pages.map((p) => `=== ${p.url}\n${p.text}`).join("\n\n")}` }],
    }, { maxRetries: 2 }) : await client.messages.create({
      model: MODEL, max_tokens: 8000, system: system.replace("only facts stated on the pages given", `only facts stated on pages you fetched from ${host} (or the city's contracted providers it links to)`),
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8, allowed_domains: [host] }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10, max_content_tokens: 12000 }],
      messages: [{ role: "user", content: `Topic file: ${topic} (themes: ${keys.join(", ")}). Search ${host} for the resident-facing pages on these themes, fetch the best ${PER_TOPIC} of them, then write the file. Finish with the Markdown only.` }],
    }, { maxRetries: 4 }); } catch (e) { console.log(`  ${topic}: ${e.message}`); continue; } // one failed topic must not drop the rest of the city
    if (!pages.length) console.log(`  ${topic}: no fetchable pages, used web tools`);
    const md = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!/^## /m.test(md)) { console.log(`  ${topic}: model returned no sections`); continue; }
    fs.writeFileSync(`${dir}/${topic}.md`, `# ${j.name} - ${topic.replace(/-/g, " ")}\n\nGenerated ${new Date().toISOString().slice(0, 10)} from ${j.site} pages listed in each section's Source line.\n\n${md.replace(/^# .*\n+/, "")}\n`);
    console.log(`  ${topic}: ${pages.length} pages → ${(md.match(/^## /gm) ?? []).length} sections`);
  }
}

//   node knowledge-gen.js --all              # every draft jurisdiction without a knowledge folder
//   node knowledge-gen.js a b c              # several ids (run a few of these in parallel to go faster)
const args = process.argv.slice(2);
const targets = args[0] === "--all" ? SERVED.filter((j) => j.draft && !fs.existsSync(`./knowledge/${j.id}`)) : args.map(jurById).filter(Boolean);
if (!targets.length) { console.error("usage: node knowledge-gen.js <jurisdiction-id>... | --all"); process.exit(1); }
for (const j of targets) { try { await generate(j); } catch (e) { console.error(`${j.id}: ${e.message}`); } }
