// Collect only images explicitly identified as city seals in each city's infobox.
// Keep source pages and image attribution alongside the local, resized assets.
import fs from 'node:fs';
import { JURS } from '../jurisdictions.js';

const headers = { 'User-Agent': 'GovAI/1.0 (city seal asset collection)' };
async function query(params) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'query', format: 'json', redirects: '1', ...params });
  let response;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (response.status !== 429) break;
    await new Promise(r => setTimeout(r, 15000 * (attempt + 1)));
  }
  if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(result.error.info);
  return result.query;
}
fs.mkdirSync('public/seals', { recursive: true });
const cities = JURS.filter(j => j.kind === 'city');
const manifest = fs.existsSync('public/seals/manifest.json') ? JSON.parse(fs.readFileSync('public/seals/manifest.json', 'utf8')) : {};
const supplement = JSON.parse(fs.readFileSync('config/city_seal_sources.json', 'utf8'));
for (let i = 0; i < cities.length; i += 20) {
  const batch = cities.slice(i, i + 20);
  if (batch.every(j => manifest[j.id]?.src || supplement[j.id])) continue;
  const titles = batch.map(j => `${j.short}, California`);
  const result = await query({ prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.join('|') });
  const pages = Object.values(result.pages);
  const candidates = [];
  for (const j of batch) {
    if (manifest[j.id]?.src || supplement[j.id]) continue;
    const title = `${j.short}, California`;
    const normalized = result.normalized?.find(n => n.from === title)?.to ?? title;
    const redirected = result.redirects?.find(r => r.from === normalized)?.to ?? normalized;
    const page = pages.find(p => p.title === redirected);
    const content = page?.revisions?.[0]?.slots?.main?.['*'] ?? '';
    const match = content.match(/^\s*\|\s*image_seal\s*=\s*([^\n|]+)/im);
    const filename = match?.[1].replace(/<!--.*?-->/g, '').replace(/^(?:File|Image):/i, '').trim();
    if (!filename || /[{}\[\]<>]/.test(filename)) { manifest[j.id] = { unavailable: true, source: `https://en.wikipedia.org/wiki/${encodeURIComponent(redirected)}` }; continue; }
    candidates.push({ j, filename, redirected });
  }
  const info = candidates.length ? await query({ prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '120', titles: candidates.map(c => `File:${c.filename}`).join('|') }) : { pages: {} };
  for (const { j, filename, redirected } of candidates) {
    try {
      const normalized = info.normalized?.find(n => n.from === `File:${filename}`)?.to ?? `File:${filename}`;
      const image = Object.values(info.pages).find(p => p.title === normalized)?.imageinfo?.[0];
      if (!image) throw new Error('Missing image');
      const imageUrl = image.thumburl ?? image.url;
      await new Promise(r => setTimeout(r, 1200));
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { response = await fetch(imageUrl, { headers, signal: AbortSignal.timeout(15000) }); if (response.ok || response.status !== 429) break; } catch (e) { if (attempt === 2) throw e; }
        await new Promise(r => setTimeout(r, 5000));
      }
      if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
      const type = response.headers.get('content-type')?.split(';')[0];
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' }[type];
      if (!ext) throw new Error(`Unexpected image type ${type}`);
      const local = `/seals/${j.id}.${ext}`;
      fs.writeFileSync(`public${local}`, Buffer.from(await response.arrayBuffer()));
      manifest[j.id] = { src: local, source: image.descriptionurl, original: image.url,
        license: image.extmetadata?.LicenseShortName?.value ?? '',
        attribution: image.extmetadata?.Artist?.value ?? '',
        cityPage: `https://en.wikipedia.org/wiki/${encodeURIComponent(redirected)}` };
    } catch (error) { manifest[j.id] = { unavailable: true, filename, error: error.message }; }
  }
  fs.writeFileSync('public/seals/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Checked ${Math.min(i + 20, cities.length)}/${cities.length} cities; ${Object.values(manifest).filter(x => x.src).length} seals saved`);
}
for (const [id, asset] of Object.entries(supplement)) {
  if (manifest[id]?.src) continue;
  const response = await fetch(asset.image, { headers: { ...headers, Referer: asset.source }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  const type = response.headers.get('content-type')?.split(';')[0];
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' }[type];
  if (!ext) throw new Error(`${id}: unexpected image type ${type}`);
  const src = `/seals/${id}.${ext}`;
  fs.writeFileSync(`public${src}`, Buffer.from(await response.arrayBuffer()));
  manifest[id] = { src, source: asset.source, original: asset.image, attribution: `City of ${cities.find(j => j.id === id).short}` };
}
// Store human-readable credits, without upstream markup or expiring URL query strings.
for (const asset of Object.values(manifest)) {
  if (asset.attribution) asset.attribution = asset.attribution.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (asset.original) asset.original = asset.original.split('?')[0];
}
fs.writeFileSync('public/seals/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Complete: ${Object.values(manifest).filter(x => x.src).length}/${cities.length} city seals`);
