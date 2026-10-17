// Golden-question retrieval check, offline against the store: does the right page surface in the top 3 for the questions residents
// actually ask? One JSONL per jurisdiction: {"q","jur","kind"?:"council","expect":{"url"|"domain"|"url_re"},"at"?:3,"status":"verified"|"proposed"}.
// "verified" lines fail the run (and npm test); "proposed" lines only report, flip them once a human has eyeballed the hit.
//   node evals/run.mjs [jur-prefix]        GOVAI_DB=:memory: node evals/run.mjs   (fresh index from data/ + knowledge/)
import fs from "node:fs";
import { buildIndex } from "../rag.js";

import { loadCouncilCache } from "../council.js";
import { loadTranscriptCache } from "../transcripts.js";
import { jurById } from "../jurisdictions.js";

const idx = await buildIndex();
const files = fs.readdirSync("./evals").filter((f) => f.endsWith(".jsonl") && (!process.argv[2] || f.startsWith(process.argv[2])));
const cases = files.flatMap((f) => fs.readFileSync(`./evals/${f}`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
for (const id of new Set(cases.map((c) => c.jur))) { const j = jurById(id); if (j) idx.addDocs([...loadCouncilCache(j).docs, ...loadTranscriptCache(j).docs]); } // council/transcripts live in data/<jur>, not in buildIndex
let n = 0, fail = 0, miss = 0;
for (const c of cases) {
  n++;
  const rows = c.kind === "council" ? idx.searchCouncil(c.q, 3, undefined, undefined, c.jur) : idx.search(c.q, 3, c.jur);
  const hit = rows.findIndex((r) => c.expect.url ? r.url === c.expect.url : c.expect.domain ? r.url?.includes(c.expect.domain) : new RegExp(c.expect.url_re, "i").test(r.url ?? ""));
  const ok = hit >= 0 && hit < (c.at ?? 3);
  if (!ok) { if (c.status === "verified") fail++; else miss++; }
  console.log(`${ok ? "ok  " : c.status === "verified" ? "FAIL" : "miss"} ${c.jur.padEnd(18)} hit@${hit >= 0 ? hit + 1 : "-"}  ${c.q}${ok ? "" : `  → got ${rows.slice(0, 2).map((r) => r.url).join(" | ")}`}`);
}
console.log(`evals: ${n - fail - miss}/${n} hit, ${fail} verified failures, ${miss} proposed misses`);
if (fail) process.exit(1);
