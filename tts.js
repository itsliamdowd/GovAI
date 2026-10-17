// Free, local, open-source TTS for voice mode: Kokoro-82M (Apache 2.0) via kokoro-js on CPU.
// ~90 MB q8 model downloads once from Hugging Face into node_modules/@huggingface/transformers/.cache.
// ponytail: whole-reply WAV, not streamed; switch to tts.stream() if first-word latency matters.
const VOICE = process.env.TTS_VOICE || "af_heart"; // best-graded voice; see https://github.com/hexgrad/kokoro for the list
let model = null;
export function loadTTS() {
  return model ??= import("kokoro-js").then(({ KokoroTTS }) => KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" }));
}
/** Text → WAV buffer (24 kHz mono). */
export async function speakWav(text) {
  const tts = await loadTTS();
  const audio = await tts.generate(text.slice(0, 2000), { voice: VOICE, speed: Number(process.env.TTS_SPEED) || 1 });
  return Buffer.from(audio.toWav());
}
