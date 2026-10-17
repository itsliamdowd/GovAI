// Optional offline Python importer -> the existing in-process BM25 document format.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export const YOUTUBE_DIR = new URL("./data/youtube/", import.meta.url);
const directoryURL = (dir) => dir instanceof URL ? dir : pathToFileURL(path.resolve(dir) + path.sep);

export function loadYouTubeDocs(dir = YOUTUBE_DIR, log = console.error) {
  const file = new URL("chunks.jsonl", directoryURL(dir));
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code !== "ENOENT") log(`YouTube cache: ${e.message}`); return []; }
  const docs = [], seen = new Set();
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      if (!c.chunk_id || !/^[\w-]{11}$/.test(c.video_id) || typeof c.text !== "string" ||
          !Number.isFinite(c.start) || c.start < 0 || !Number.isFinite(c.end) || c.end < c.start) {
        throw new Error("invalid chunk");
      }
      if (seen.has(c.chunk_id)) continue;
      seen.add(c.chunk_id);
      // Derive links from validated IDs/times, never a cached arbitrary URL.
      const url = `https://www.youtube.com/watch?v=${c.video_id}&t=${Math.floor(c.start)}s`;
      docs.push({ ...c, kind: "youtube_video", doc: "transcript", part: c.chunk_id, url,
        title: `${c.channel_name}: ${c.title}`,
        searchText: `${c.region ?? ""} ${c.jurisdiction ?? ""} ${c.channel_name} ${c.title} ${c.published_at ?? ""} ${c.text}` });
    } catch { log(`YouTube cache: skipping invalid chunk on line ${i + 1}`); }
  }
  return docs;
}

export function loadYouTubeRecord(videoId, dir = YOUTUBE_DIR) {
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  try {
    const base = directoryURL(dir);
    return JSON.parse(fs.readFileSync(new URL(`records/${videoId}.json`, base), "utf8"));
  } catch { return null; }
}
