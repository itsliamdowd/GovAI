// Shared polite fetcher for every agenda/video/site adapter: per-host concurrency + spacing, browser-like UA that
// still identifies us, retry with backoff on 429/503, no retries on 403 (Cloudflare walls), content sniffing so a
// PDF served without a .pdf extension (CivicPlus ViewFile, PrimeGov CompiledDocument) still becomes text.
// ponytail: in-process queues only; robots.txt is honored by crawl.js (sites), not here (agenda portals are built to be fetched).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
// A plain browser UA: Cloudflare-fronted city sites (Burbank, Glendale, Downey…) 403 any UA with an extra product token. We identify
// ourselves the standard way instead: a From: header with the contact mailbox (CONTACT_EMAIL) on every request.
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FROM = process.env.CONTACT_EMAIL ? { From: process.env.CONTACT_EMAIL } : {};
const hosts = new Map(); // host -> { active, last }
const limits = { concurrency: Number(process.env.FETCH_CONCURRENCY) || 2, gapMs: Number(process.env.FETCH_GAP_MS) || 400 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function slot(host) {
  const h = hosts.get(host) ?? hosts.set(host, { active: 0, last: 0 }).get(host);
  while (h.active >= limits.concurrency || Date.now() - h.last < limits.gapMs) await sleep(50);
  h.active++; h.last = Date.now();
  return () => { h.active--; h.last = Date.now(); };
}

export class BlockedError extends Error { constructor(url, status) { super(`${status} ${url}`); this.blocked = true; this.status = status; } }

/** fetch() with per-host politeness, timeout and backoff. Throws BlockedError on 403 so callers can stop hammering a walled host. */
export async function politeFetch(url, { timeout = 45000, headers = {}, retries = 3, ...init } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const release = await slot(host);
    let r;
    try { r = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml,application/json,application/pdf,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", ...FROM, ...headers }, signal: AbortSignal.timeout(timeout), redirect: "follow" }); }
    catch (e) { release(); if (attempt < retries) { await sleep(2000 * 4 ** attempt); continue; } throw e; }
    release();
    if (r.status === 403) throw new BlockedError(url, 403);
    if ((r.status === 429 || r.status >= 500) && attempt < retries) { const ra = Number(r.headers.get("retry-after")); await sleep(ra ? ra * 1000 : 2000 * 4 ** attempt); continue; }
    return r;
  }
}

export const html2text = (h) => String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "")
  .replace(/<\/(p|div|li|tr|h\d|section|article|table|ul|ol)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/t[dh]>/gi, " \t").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#xa0;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;?|&apos;|&#8217;|&[lr]squo;/g, "'").replace(/&#8220;|&#8221;|&[lr]dquo;/g, '"').replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&sect;/g, "§").replace(/&hellip;/g, "...").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

// ponytail: shells out to poppler's pdftotext (brew install poppler). Missing binary -> throws, caller logs and moves on.
export async function pdfToText(buf) {
  const tmp = path.join(os.tmpdir(), `govai-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    const { stdout } = await run("pdftotext", ["-layout", tmp, "-"], { maxBuffer: 100e6 });
    return stdout.replace(/[ \t]{2,}/g, "  ").replace(/\n{3,}/g, "\n\n").trim();
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** GET a document and return plain text whatever it is: PDF (by content-type or magic bytes) -> pdftotext, else HTML -> text. */
export async function fetchText(url, opts = {}) {
  const r = await politeFetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const type = r.headers.get("content-type") ?? "";
  if (/pdf/i.test(type) || buf.subarray(0, 5).toString() === "%PDF-") return pdfToText(buf);
  return html2text(buf.toString("utf8"));
}
export async function fetchJson(url, opts = {}) { const r = await politeFetch(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}) } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
export async function fetchHtml(url, opts = {}) { const r = await politeFetch(url, opts); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text(); }

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
/** "September 22, 2026" | "Sep 22, 2026" | "03/03/21" | "2026-09-22T18:00:00" | "_09222026-2793" -> "2026-09-22" (null if undated). */
export function toYmd(s) {
  if (!s) return null; s = String(s);
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) { const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`; }
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900; return `${y}-${String(+m[1]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`; }
  m = s.match(/_(\d{2})(\d{2})(\d{4})-/); if (m) return `${m[3]}-${m[1]}-${m[2]}`; // CivicPlus _MMDDYYYY-ID
  m = s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/); if (m) return `${m[3]}-${String(+m[1]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
  return null;
}
export const safeId = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
export const absUrl = (href, base) => { try { return new URL(href.replace(/&amp;/g, "&"), base).href; } catch { return ""; } };
