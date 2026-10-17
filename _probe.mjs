// temp diagnostic, delete after use
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
const el = (t0) => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const variants = [
  { name: "as-server (fallback beta + effort)", opts: { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "medium" } } },
  { name: "no beta, effort medium", opts: { output_config: { effort: "medium" } } },
  { name: "plain", opts: {} },
];
for (const { name, opts } of variants) {
  const t0 = Date.now();
  console.log("\n==", name);
  const stream = client.beta.messages.stream({ model: "claude-opus-5-5", max_tokens: 500, messages: [{ role: "user", content: "Say hi in three words." }], ...opts });
  stream.on("streamEvent", (e) => console.log(el(t0), e.type, e.content_block?.type ?? e.delta?.type ?? ""));
  const timer = setTimeout(() => { console.log(el(t0), "TIMEOUT 40s, aborting"); stream.abort(); }, 40000);
  try { const m = await stream.finalMessage(); console.log(el(t0), "done", m.stop_reason, m.model, JSON.stringify(m.content).slice(0, 120)); }
  catch (e) { console.log(el(t0), "ERR", e.status ?? "", String(e.message).slice(0, 300)); }
  clearTimeout(timer);
}
