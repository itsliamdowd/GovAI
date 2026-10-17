// City website -> knowledge sections, in the exact format knowledge/<jur>/*.md uses ("## heading", body, "Source: url"),
// so rag.js chunkMarkdown() indexes crawled pages with the same section-level citations as the hand-written Santa Monica files.
//   node crawl.js <jurisdiction-id> [--max 600]      -> data/knowledge/<jur>/site.md  (gitignored; rebuilt monthly)
// Pipeline: robots.txt (Disallow + Crawl-delay honored) -> sitemap.xml (recursive) or a shallow same-host BFS -> URL scoring
// (process pages first: permits, fees, trash, parking, licenses…) -> fetch cap -> main-content extraction -> "## H1 — H2" sections
// <= 900 chars -> per-site boilerplate removal (lines seen on >= 5 pages) -> hash dedupe -> process-explainer score >= 2 kept.
// ponytail: regex HTML, no DOM library; distill.js (Claude Haiku rewrite into fee/step sections) layers on top later.
import fs from "node:fs";
import crypto from "node:crypto";
import { politeFetch, html2text, absUrl, UA } from "./adapters/_http.js";

const DROP = /\/(news|press|calendar|events?|event-|blog|gallery|photos?|videos?|archive|search|login|jobs?|careers|rfp|bids?|agendas?|minutes|category|tag|author|feed|directory|staff|sitemap|rss|share|print|translate|es|zh|ko|hy|tl|ru)(\/|$|\.)|\.(docx?|xlsx?|pptx?|jpe?g|png|gif|svg|mp4|mp3|zip|ics|xml|json|css|js)($|\?)|\?|#|\/es\/|lang=|\/wp-json\/|\/wp-content\/uploads\/.*\.(pdf)$/i;
const BOOST = /permit|licen|fee|apply|application|how-?to|process|services?|trash|recycl|refuse|bulky|parking|animal|dog|business|rent|tenant|housing|311|contact|council|clerk|records|utility|water|sewer|street|sidewalk|tree|code-?enforcement|noise|short-?term|vending|film|event-?permit|block-?party|building|planning|zoning|adu|garage-?sale|alarm|fireworks|senior|library|park|pool|transit|bus|bike|ev-?charg|tax|budget|election|vote|emergency|evacuat|fire|police|faq/i;
const EXPLAINER = [/\$\s?\d/, /\bfees?\b/i, /\bapply|application\b/i, /\bpermit|licen[cs]e\b/i, /\brequired|must\b/i, /\bdeadline|business days|calendar days\b/i, /\bsubmit\b/i, /\bhow to|step\b/i, /\brenew/i, /\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/, /@[a-z0-9.-]+\.(gov|org|us|com)/i];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function get(url, timeout = 30000) { const r = await politeFetch(url, { timeout, retries: 1 }); return { ok: r.ok, status: r.status, type: r.headers.get("content-type") ?? "", text: r.ok ? await r.text() : "" }; }

export async function robots(site) {
  const out = { disallow: [], delay: 1000, sitemaps: [] };
  try {
    const { ok, text } = await get(new URL("/robots.txt", site).href, 15000); if (!ok) return out;
    let applies = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
      const [k, ...rest] = line.split(":"); const v = rest.join(":").trim(), key = k.trim().toLowerCase();
      if (key === "user-agent") applies = v === "*" || /govai/i.test(v);
      else if (key === "sitemap") out.sitemaps.push(v);
      else if (applies && key === "disallow" && v) out.disallow.push(v);
      else if (applies && key === "crawl-delay") out.delay = Math.min(10000, Math.max(1000, Number(v) * 1000 || 1000));
    }
  } catch {}
  return out;
}
const allowed = (url, rb) => { const p = new URL(url).pathname; return !rb.disallow.some((d) => d === "/" ? true : p.startsWith(d.replace(/\*$/, ""))); };

async function sitemapUrls(site, rb, cap = 5000) {
  const seen = new Set(), urls = [];
  const walk = async (u, depth = 0) => {
    if (seen.has(u) || depth > 3 || urls.length >= cap) return; seen.add(u);
    let x; try { x = await get(u, 30000); } catch { return; } if (!x.ok) return;
    const locs = [...x.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
    if (/<sitemapindex/i.test(x.text)) { for (const l of locs) await walk(l, depth + 1); }
    else for (const l of locs) { if (urls.length >= cap) break; urls.push(l); }
  };
  for (const u of [...rb.sitemaps, new URL("/sitemap.xml", site).href, new URL("/sitemap_index.xml", site).href, new URL("/sitemap.aspx", site).href]) { await walk(u); if (urls.length) break; }
  return urls;
}

/** Shallow same-host BFS when there is no sitemap: homepage links, then their links (depth 2). */
async function bfsUrls(site, rb, cap, delay) {
  const host = new URL(site).host.replace(/^www\./, ""), seen = new Set([site]), out = [site]; let frontier = [site];
  for (let depth = 0; depth < 2 && out.length < cap; depth++) {
    const next = [];
    for (const u of frontier) {
      let x; try { x = await get(u); } catch { continue; } await sleep(delay);
      for (const m of x.text.matchAll(/href=["']([^"'#]+)["']/gi)) {
        const a = absUrl(m[1], u); if (!a) continue;
        try { if (new URL(a).host.replace(/^www\./, "") !== host) continue; } catch { continue; }
        const clean = a.split("#")[0];
        if (!seen.has(clean) && !DROP.test(new URL(clean).pathname + new URL(clean).search) && allowed(clean, rb)) { seen.add(clean); out.push(clean); next.push(clean); if (out.length >= cap) break; }
      }
    }
    frontier = next;
  }
  return out;
}

const pathScore = (u) => { const p = new URL(u).pathname.toLowerCase(); let s = 0; for (const m of p.match(BOOST) ?? []) s += 1; s += Math.max(0, 3 - (p.split("/").filter(Boolean).length)); if (/\.pdf$/.test(p)) s -= 2; return s; };
const explainerScore = (t) => EXPLAINER.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0) - ((t.match(/\b(19|20)\d{2}-\d{2}-\d{2}\b|\b[A-Z][a-z]+ \d{1,2}, 20\d{2}\b/g) ?? []).length >= 5 ? 2 : 0) - (/posted on|read more/i.test(t) ? 2 : 0);

/** One page -> [{heading, text, url}] sections of <= 900 chars built from the main content area. */
export function extractSections(html, url) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").split(/\s[|–-]\s/)[0].trim();
  // Main region = from the main container's opening tag to the footer/end of body. Nested <div>s make "match to the
  // first closing tag" useless (CivicPlus role="main" closes 40 divs later), so we slice by position instead.
  const open = html.match(/<main\b[^>]*>|<[^>]+role=["']main["'][^>]*>|<(?:div|section|article)[^>]+(?:id|class)=["'][^"']*(?:main-?content|page-?content|content-?main|\bcontent\b|article|widgetContent|fr-view|cpContent)[^"']*["'][^>]*>/i);
  let main = open ? html.slice(open.index + open[0].length) : (html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html);
  main = main.slice(0, main.search(/<\/main>|<footer\b|<[^>]+(?:id|class)=["'][^"']*footer[^"']*["']|<\/body>/i) >>> 0 || main.length);
  main = main.replace(/<(nav|header|footer|aside|form|script|style|noscript|iframe|svg|button|select)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+(aria-hidden=["']true["']|class=["'][^"']*(breadcrumb|share|sidebar|skip|menu|navbar|cookie|social|footer|header)[^"']*["'])[^>]*>[\s\S]*?<\/(div|ul|section|span)>/gi, "");
  const h1 = html2text(main.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") || title;
  const blocks = []; // [{level, heading}|{text}]
  const re = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>|<(p|li|td|th|dd|dt|blockquote)\b[^>]*>([\s\S]*?)<\/\3>/gi;
  const seenLine = new Set(); // CivicPlus FAQ/accordion pages repeat category labels dozens of times
  for (const m of main.matchAll(re)) {
    if (m[1]) { const t = html2text(m[2]); if (t && t.length < 160) blocks.push({ level: +m[1][1], heading: t }); continue; }
    if (/<(p|li|td)\b/i.test(m[4])) continue; // nested block: children match on their own
    const t = html2text(m[4]).replace(/\s*\n\s*/g, " ").trim(), k = norm(t);
    if (t.length < 25 && !/[.:$%]|\d/.test(t) || seenLine.has(k)) continue; // link-list fragments, repeats
    seenLine.add(k); blocks.push({ text: t });
  }
  // Text in bare <div>/<span>s (CivicPlus fr-view widgets): fall back to the flattened main region when blocks caught little of it.
  const got = blocks.reduce((n, b) => n + (b.text?.length ?? 0), 0), flat = html2text(main);
  if (got < flat.length * 0.3 && flat.length > 400) {
    blocks.length = 0; const seen2 = new Set();
    for (const line of flat.split("\n")) { const t = line.trim(), k = norm(t); if (t.length >= 25 && !seen2.has(k)) { seen2.add(k); blocks.push({ text: t }); } }
  }
  const sections = []; let heading = h1, cur = [];
  const flush = () => { const body = cur.join("\n").trim(); if (body.length >= 60) sections.push({ heading: heading.slice(0, 120), text: body, url }); cur = []; };
  for (const b of blocks) {
    if (b.heading !== undefined) { if (cur.length) flush(); heading = b.level === 1 || !h1 || b.heading === h1 ? b.heading : `${h1} — ${b.heading}`; continue; }
    const line = /^[-•*\d]/.test(b.text) ? b.text : b.text;
    if (cur.join("\n").length + line.length > 900 && cur.length) { flush(); }
    cur.push(line);
  }
  if (cur.length) flush();
  return sections;
}

export async function crawlSite(j, { max = Number(process.env.CRAWL_MAX_PAGES) || 600, log = console.error } = {}) {
  const site = j.crawl?.root ?? j.site; if (!site) return { pages: 0, sections: 0 };
  const rb = await robots(site);
  if (rb.disallow.includes("/")) { log(`crawl ${j.id}: robots.txt disallows everything`); return { pages: 0, sections: 0, blocked: true }; }
  const delay = Math.max(rb.delay, Number(j.crawl?.delay_ms) || 1000);
  let urls = await sitemapUrls(site, rb);
  const via = urls.length ? "sitemap" : "bfs";
  if (!urls.length) urls = await bfsUrls(site, rb, max * 3, delay);
  const host = new URL(site).host.replace(/^www\./, "");
  urls = [...new Set(urls.map((u) => u.split("#")[0]))].filter((u) => { try { const x = new URL(u); return x.host.replace(/^www\./, "") === host && !DROP.test(x.pathname + x.search) && allowed(u, rb) && !(j.crawl?.exclude && new RegExp(j.crawl.exclude, "i").test(u)); } catch { return false; } })
    .sort((a, b) => pathScore(b) - pathScore(a)).slice(0, max);
  log(`crawl ${j.id}: ${urls.length} urls via ${via}, delay ${delay} ms`);
  const pages = [];
  for (const u of urls) {
    try {
      const x = await get(u); if (!x.ok || !/html/i.test(x.type)) continue;
      const secs = extractSections(x.text, u); if (secs.length) pages.push(secs);
    } catch (e) { if (e.blocked) { log(`crawl ${j.id}: 403 at ${u}, stopping`); break; } }
    await sleep(delay);
  }
  // boilerplate: a line that appears on >= 5 pages (or 10% of pages) is chrome, not content
  const freq = new Map(); for (const p of pages) for (const line of new Set(p.flatMap((s) => s.text.split("\n").map(norm)))) freq.set(line, (freq.get(line) ?? 0) + 1);
  const chrome = (line) => (freq.get(norm(line)) ?? 0) >= Math.max(5, pages.length * 0.1);
  const seen = new Set(), out = [];
  for (const p of pages) for (const s of p) {
    const text = s.text.split("\n").filter((l) => !chrome(l)).join("\n").trim(); if (text.length < 60) continue;
    const key = sha(norm(text)); if (seen.has(key)) continue; seen.add(key);
    if (explainerScore(`${s.heading}\n${text}`) < 2) continue;
    out.push({ ...s, text });
  }
  const dir = `./data/knowledge/${j.id}`; fs.mkdirSync(dir, { recursive: true });
  const md = [`# ${j.name} website\n`, `Crawled ${new Date().toISOString().slice(0, 10)} from ${site} (${pages.length} pages, ${out.length} sections). Fees and dates change; confirm with web_search when a question hinges on a current number.\n`,
    ...out.map((s) => `## ${s.heading.replace(/\n/g, " ")}\n\n${s.text}\n\nSource: ${s.url}\n`)].join("\n");
  fs.writeFileSync(`${dir}/site.md`, md);
  log(`crawl ${j.id}: ${pages.length} pages -> ${out.length} sections -> ${dir}/site.md`);
  return { pages: pages.length, sections: out.length, via };
}

if (process.argv[1]?.endsWith("crawl.js")) {
  const { jurById, SERVED } = await import("./jurisdictions.js");
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--")), max = Number(process.argv[process.argv.indexOf("--max") + 1]) || undefined;
  const jurs = ids.length ? ids.map((id) => jurById(id)).filter(Boolean) : SERVED.filter((j) => j.site && !j.context);
  for (const j of jurs) { try { console.log(j.id, await crawlSite(j, { max })); } catch (e) { console.error(`crawl ${j.id} failed: ${e.message}`); } }
}
