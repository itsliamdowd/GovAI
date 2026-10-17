// "Track X" daily watch. Per alert: gather what the RAG index (knowledge + council records) and
// data.santamonica.gov currently say about the topic, diff against keys already seen, ask a judge
// model "did something change for this resident?" yes/no, and email only on yes.
// ponytail: JSON file store + in-process daily timer; move to a queue/DB when there is >1 server instance.
import fs from "node:fs";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { queryDataset } from "./rag.js";
import { jurById } from "./jurisdictions.js";

const FILE = "./data/alerts.json";
const OUTBOX = "./data/outbox";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-haiku-5-5"; // ponytail: cheap yes/no judge; raise to sonnet if it misses real changes
try { process.loadEnvFile(); } catch {} // this module is imported before server.js's body runs, so it must load .env itself
const client = new Anthropic();

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } };
const save = (a) => { fs.mkdirSync("./data", { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(a, null, 2)); };
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Everything the index + open data currently say about a topic, as {key,title,url,text}. */
export async function gatherEvidence(rag, topic, jur = "santa-monica") {
  const items = [];
  for (const d of rag.searchCouncil(topic, 10, "", "", jur)) items.push({ key: hash(d.url + d.text), title: d.title, url: d.url, text: d.text.slice(0, 1200) });
  const hits = rag.search(topic, 6, jur);
  for (const d of hits) {
    if (d.kind === "knowledge") { items.push({ key: hash(d.title + d.text), title: d.title, url: "", text: d.text }); continue; }
    const r = d.resources?.[0]; if (!r) continue;
    try {
      const { records } = await queryDataset({ resource_id: r.resource_id, q: topic, limit: 10, portal: d.portal });
      for (const { _id, ...row } of records) { const text = JSON.stringify(row); items.push({ key: hash(r.resource_id + text), title: d.title, url: d.url, text }); }
    } catch (e) { console.error(`alert evidence ${d.title}: ${e.message}`); }
  }
  return items;
}
export const diffEvidence = (seen, items) => { const s = new Set(seen); return items.filter((i) => !s.has(i.key)); };

export async function createAlert(rag, { topic, address = "", email, name = "", jur = "santa-monica" }) {
  const alerts = load();
  let id; do { id = "WATCH-" + crypto.randomInt(0, 1e6).toString().padStart(6, "0"); } while (alerts[id]);
  const baseline = await gatherEvidence(rag, [topic, address].filter(Boolean).join(" "), jur);
  alerts[id] = {
    confirmation_number: id, status: "watching", department: "Daily watch", topic, address, email, name, jur,
    summary: `Watching: ${topic}${address ? ` (${address})` : ""} — daily check, email on change`,
    next_steps: `Checked every morning. You'll get an email at ${email} only when something new turns up. Say "cancel ${id}" to stop.`,
    seen: baseline.map((i) => i.key), notified: [], submitted_at: new Date().toISOString(), last_checked: null,
  };
  save(alerts);
  return alerts[id];
}
export function cancelAlert(id) {
  const alerts = load(), k = id.trim().toUpperCase();
  if (!alerts[k]) return { error: "No watch found with that number." };
  delete alerts[k]; save(alerts);
  return { confirmation_number: k, status: "cancelled" };
}
export const listAlerts = () => Object.values(load()).map(({ seen, ...a }) => a);

const DECIDE = {
  name: "decide", strict: true,
  description: "Record whether anything materially changed for the resident's watched topic and, if so, the email to send.",
  input_schema: {
    type: "object",
    properties: {
      changed: { type: "boolean" },
      reason: { type: "string", description: "One sentence." },
      subject: { type: "string", description: "Email subject if changed, else empty string." },
      body: { type: "string", description: "Plain-text email if changed (what changed, when, source links, what they can do), else empty string." },
    },
    required: ["changed", "reason", "subject", "body"], additionalProperties: false,
  },
};
export async function judge(alert, fresh) {
  const res = await client.messages.create({
    model: JUDGE_MODEL, max_tokens: 1500, tools: [DECIDE], tool_choice: { type: "tool", name: "decide" },
    system: `You are the ${jurById(alert.jur)?.name ?? "City of Santa Monica"}'s change detector. A resident asked to be told when something changes about their topic. You receive only records that are NEW since the last check: council agendas, minutes, transcript excerpts, open-data rows, city knowledge. Decide strictly. changed=true only if a new record substantively concerns the resident's topic or address: a council item or vote, permit, license, inspection, fee, rule, service change, incident. Passing mentions, boilerplate, retrieval noise or rows about other addresses mean changed=false. If true, write a short plain-text email signed '${jurById(alert.jur)?.name ?? "City of Santa Monica"} Assistant'.`,
    messages: [{ role: "user", content: `Topic: ${alert.topic}\nAddress: ${alert.address || "n/a"}\nToday: ${new Date().toISOString().slice(0, 10)}\n\nNew records:\n${fresh.map((i, n) => `[${n + 1}] ${i.title} ${i.url}\n${i.text}`).join("\n\n")}` }],
  }, { maxRetries: 2 });
  return res.content.find((b) => b.type === "tool_use").input;
}

export async function sendEmail({ to, subject, body }) {
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.ALERT_FROM || "GovAI Assistant <onboarding@resend.dev>", to, subject, text: body }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
    return "sent";
  }
  fs.mkdirSync(OUTBOX, { recursive: true }); // no mail provider configured: drop it in the outbox so the demo still shows the result
  fs.writeFileSync(`${OUTBOX}/${Date.now()}-${to.replace(/[^\w.@-]/g, "_")}.txt`, `To: ${to}\nSubject: ${subject}\n\n${body}\n`);
  return "outbox";
}

/** Daily job. Returns [{id, new, changed, delivery?}] for logging / the /api/alerts/run endpoint. */
export async function runAlerts(rag, log = console.log) {
  const alerts = load(), out = [];
  for (const a of Object.values(alerts)) {
    const r = { id: a.confirmation_number, new: 0, changed: false };
    try {
      const fresh = diffEvidence(a.seen, await gatherEvidence(rag, [a.topic, a.address].filter(Boolean).join(" "), a.jur ?? "santa-monica"));
      r.new = fresh.length;
      if (fresh.length) {
        const d = await judge(a, fresh);
        r.changed = d.changed; r.reason = d.reason;
        if (d.changed) { r.delivery = await sendEmail({ to: a.email, subject: d.subject, body: d.body }); a.notified.push({ at: new Date().toISOString(), subject: d.subject }); }
        a.seen = [...a.seen, ...fresh.map((i) => i.key)].slice(-2000);
      }
      a.last_checked = new Date().toISOString();
    } catch (e) { r.error = e.message; }
    log(`alert ${r.id}: ${r.new} new, changed=${r.changed}${r.delivery ? ` (${r.delivery})` : ""}${r.error ? ` ERROR ${r.error}` : ""}`);
    out.push(r);
  }
  save(alerts);
  return out;
}
