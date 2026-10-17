// Temporary: does the post-tool turn stream on other models? Deleted after use.
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
const tool = { name: "search_city_knowledge", description: "Retrieve city knowledge for a question.", strict: true, input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
async function run(model) {
  const base = { model, max_tokens: 600, tools: [tool] };
  const messages = [{ role: "user", content: "What is Santa Monica 311? Use search_city_knowledge first, then answer in three sentences." }];
  const m1 = await client.beta.messages.stream({ ...base, messages }).finalMessage();
  const tu = m1.content.find((b) => b.type === "tool_use");
  if (!tu) { console.log(`${model.padEnd(18)} (no tool call on turn 1)`); return; }
  messages.push({ role: "assistant", content: m1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "Santa Monica 311: dial 311 in city limits or (866) 311-7266; 24/7 online, app, 311@santamonica.gov. Non-emergency city services." }] });
  const t0 = Date.now(), s = [];
  const st = client.beta.messages.stream({ ...base, messages }); st.on("text", () => s.push(Date.now() - t0));
  await st.finalMessage();
  console.log(`${model.padEnd(18)} turn2 deltas=${s.length} first=${s[0]}ms spread=${s.at(-1) - s[0]}ms distinct=${new Set(s).size}`);
}
for (const m of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]) { try { await run(m); } catch (e) { console.log(`${m.padEnd(18)} error: ${e.message.slice(0, 120)}`); } }
