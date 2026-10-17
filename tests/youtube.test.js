import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadYouTubeDocs, loadYouTubeRecord } from "../youtube.js";
import { buildIndex } from "../rag.js";
import { clipWindow } from "../transcripts.js";

test("JSONL cache adapts to existing BM25 search; missing/bad records are safe", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "govai-youtube-"));
  const originalDb = process.env.GOVAI_DB;
  process.env.GOVAI_DB = ":memory:";
  const originalFetch = globalThis.fetch;
  const originalRead = fs.readFileSync;
  try {
    assert.deepEqual(loadYouTubeDocs(dir), []);
    const c = { chunk_id: "abcdefghijk:0", video_id: "abcdefghijk", channel_name: "SMPD",
      jurisdiction: "City of Santa Monica", title: "Bicycle safety", start: 123.4, end: 127.6, text: "bicycle visibility safety advice" };
    fs.writeFileSync(path.join(dir, "chunks.jsonl"), [JSON.stringify(c), "bad json", JSON.stringify(c)].join("\n"));
    const warnings = [], docs = loadYouTubeDocs(dir, (s) => warnings.push(s));
    assert.equal(docs.length, 1);
    assert.equal(warnings.length, 1);
    assert.equal(docs[0].url, "https://www.youtube.com/watch?v=abcdefghijk&t=123s");
    assert.equal(docs[0].kind, "youtube_video");
    // Avoid catalog network calls; this exercises the real index and addDocs contract.
    globalThis.fetch = async () => { throw new Error("offline test"); };
    fs.readFileSync = function(file, ...args) {
      const filename = String(file);
      if (filename.endsWith("/data/youtube/chunks.jsonl")) return JSON.stringify(c) + "\n";
      if (filename.endsWith("/data/youtube/records/abcdefghijk.json")) return JSON.stringify({
        title: c.title, transcript_available: true, published_at: "2026-10-01T00:00:00Z",
        transcript_segments: [{ text: c.text, start: 123.4, duration: 4.2 }],
      });
      return originalRead.call(this, file, ...args);
    };
    const rag = await buildIndex();
    rag.addDocs(docs); rag.addDocs(docs);
    assert.equal(rag.search("bicycle visibility").filter((d) => d.kind === "youtube_video").length, 1);
    assert.equal(rag.searchCouncil("bicycle visibility").length, 0);
    assert.equal(clipWindow(c.video_id, 123).text, c.text);
    assert.equal(clipWindow(c.video_id, 123).meeting_date, "2026-10-01");
    assert.equal(loadYouTubeRecord("../secret", dir), null);
    fs.mkdirSync(path.join(dir, "records"));
    fs.writeFileSync(path.join(dir, "records/abcdefghijk.json"), JSON.stringify({ video_id: c.video_id }));
    assert.equal(loadYouTubeRecord(c.video_id, dir).video_id, c.video_id);
  } finally {
    if (originalDb === undefined) delete process.env.GOVAI_DB; else process.env.GOVAI_DB = originalDb;
    globalThis.fetch = originalFetch;
    fs.readFileSync = originalRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
