// Collector: each city's main phone number from its own website → data/phones.json. Run: node phones.js [id ...]
// Signals, strongest first: a tel: link on the homepage/contact page; the number nearest "City Hall"; the most repeated number.
// Fax numbers and 311/911/toll-free lines are skipped. jurisdictions*.js read data/phones.json at load.
import fs from "node:fs";
import { JURS } from "./jurisdictions.js";

const OUT = "./data/phones.json";
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US" };
const PATHS = ["", "/contact", "/contact-us", "/contactus", "/government/city-hall", "/city-hall", "/about", "/departments"];
const RE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.\-–]+(\d{3})[\s.\-–]+(\d{4})\b/g;
const TOLL = new Set(["800", "888", "877", "866", "855", "844", "833"]);
const fmt = (a, b, c) => `(${a}) ${b}-${c}`;
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&#8211;|&ndash;/g, "–").replace(/\s+/g, " ");

async function page(url) {
  try { const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) }); if (!r.ok) return null; const h = await r.text(); return /Pardon Our Interruption|Access Denied|Just a moment/i.test(h.slice(0, 3000)) ? null : h; }
  catch { return null; }
}
function candidates(html) {
  const score = new Map(), bump = (p, n) => score.set(p, (score.get(p) ?? 0) + n);
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) { const d = m[1].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); if (d.length === 10 && !TOLL.has(d.slice(0, 3))) bump(fmt(d.slice(0, 3), d.slice(3, 6), d.slice(6)), 6); }
  const text = strip(html);
  for (const m of text.matchAll(RE)) {
    const [, a, b, c] = m, p = fmt(a, b, c), before = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
    if (TOLL.has(a) || /fax|tty|tdd/.test(before)) continue;
    bump(p, 1);
    if (/city hall|main|general|phone|call us|tel/.test(before)) bump(p, 2);
    if (/city hall/.test(text.slice(Math.max(0, m.index - 250), m.index + 250).toLowerCase())) bump(p, 2);
  }
  return [...score].sort((x, y) => y[1] - x[1]);
}
async function collect(j) {
  for (const p of PATHS) {
    const url = j.site.replace(/\/$/, "") + p, html = await page(url); if (!html) continue;
    const c = candidates(html); if (!c.length) continue;
    const [phone, s] = c[0];
    if (s >= 3 || p !== "") return { phone, url, score: s, alt: c.slice(1, 3).map(([q]) => q) }; // weak homepage hit: keep looking on contact pages
  }
  return null;
}

const want = process.argv.slice(2);
const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return {}; } })();
const todo = JURS.filter((j) => j.kind === "city" && !j.contact?.phone && (!want.length || want.includes(j.id)) && (want.length || !prev[j.id]?.phone));
console.log(`collecting ${todo.length} cities`);
const out = { ...prev }, queue = [...todo];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let j; (j = queue.shift());) {
    const r = await collect(j);
    out[j.id] = r ? { ...r, name: j.short, at: new Date().toISOString().slice(0, 10) } : { phone: "", name: j.short, url: j.site, note: "not found" };
    console.log(`${j.id.padEnd(24)} ${r ? r.phone + "  ← " + r.url + " (" + r.score + ")" : "— not found"}`);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }
}));
const missing = Object.values(out).filter((v) => !v.phone).length;
console.log(`done: ${Object.keys(out).length} entries, ${missing} without a number`);
