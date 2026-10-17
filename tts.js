// Free, local, open-source TTS for voice mode: Kokoro-82M (Apache 2.0) via kokoro-js on CPU. No API key, nothing leaves the box.
// Model downloads once from Hugging Face into node_modules/@huggingface/transformers/.cache (fp32 ≈ 330 MB).
// ponytail: whole-chunk WAV per sentence group (the client pipelines sentences); switch to tts.stream() if first-word latency matters.
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = process.env.TTS_VOICE || "af_heart"; // Kokoro's only A-graded voice; see https://github.com/hexgrad/kokoro for the list
// fp32 sounds cleanest (q8 adds a faint metallic edge); once warm it renders ~8 s of speech in ~2 s on a 10-core laptop, same as q8.
const DTYPE = process.env.TTS_DTYPE || "fp32";
let model = null;
export function loadTTS() {
  return model ??= import("kokoro-js").then(async ({ KokoroTTS }) => {
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: "cpu" });
    await tts.generate("Ready.", { voice: VOICE }); // the first generate pays graph init (~4 s); pay it at startup, not on a resident's first question
    return tts;
  });
}

// Make written city text read naturally: spell out IDs and phone numbers, expand street/day abbreviations, drop markdown and URLs.
const DAYS = { Mon: "Monday", Tue: "Tuesday", Tues: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Thur: "Thursday", Thurs: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const MONTHS = { Jan: "January", Feb: "February", Apr: "April", Jun: "June", Jul: "July", Aug: "August", Sep: "September", Sept: "September", Oct: "October", Nov: "November", Dec: "December" };
const STREET = { Blvd: "Boulevard", Ave: "Avenue", Rd: "Road", Hwy: "Highway", Ste: "Suite", Pkwy: "Parkway", Ln: "Lane", Ct: "Court", Pl: "Place" };
const spaced = (s) => s.split("").join(" ");
export function speechText(text) {
  return String(text)
    .replace(/https?:\/\/(?:www\.)?([^/\s)]+)\S*/gi, (_, host) => host.replace(/\./g, " dot ")) // links → "santamonica dot gov"
    .replace(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)*)\.([a-z]{2,})\b/gi, (_, u, d, tld) => `${u} at ${d.replace(/\./g, " dot ")} dot ${tld}`)
    .replace(/\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g, (_, a, b, c) => `${spaced(a)}, ${spaced(b)}, ${spaced(c)}`) // (310) 458-8411
    .replace(/\b(\d{3})[\s.-](\d{4})\b/g, (_, b, c) => `${spaced(b)}, ${spaced(c)}`) // 458-8411
    .replace(/\b([A-Z]{2,6})-(\d{4,})\b/g, (_, l, n) => `${spaced(l)}, ${spaced(n)}`) // SM-749311, WATCH-691198
    .replace(/\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\.?\s*[–—-]\s*(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b\.?/g, (_, a, b) => `${DAYS[a]} through ${DAYS[b]}`)
    .replace(/\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b\.?(?=[\s,;:)]|$)/g, (m, d) => DAYS[d] ?? m)
    .replace(/\b(Blvd|Ave|Rd|Hwy|Ste|Pkwy|Ln|Ct|Pl)\.?(?=[\s,;:)]|$)/g, (_, a) => STREET[a])
    .replace(/\b(\d+(?:st|nd|rd|th)?) St\.?(?=[\s,;:)]|$)/g, "$1 Street").replace(/\b([A-Z][a-z]+) St\.?(?=[\s,;:)]|$)/g, "$1 Street") // "Main St", "4th St" (not "St. John")
    .replace(/\bPCH\b/g, "Pacific Coast Highway").replace(/\bADU\b/g, "A D U").replace(/\bSMPD\b/g, "Santa Monica Police").replace(/\bSMFD\b/g, "Santa Monica Fire")
    .replace(/\b(Jan|Feb|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?(?=\s+\d)/g, (_, m) => MONTHS[m]) // "Jul 1" → "July 1"
    .replace(/\b24\/7\b/g, "twenty-four seven")
    .replace(/\b([ap])\.m\.(?=\s+[A-Z]|\s*$)/gi, (_, x) => `${x.toUpperCase()}M.`).replace(/\b([ap])\.m\.?(?=\W|$)/gi, (_, x) => `${x.toUpperCase()}M`) // keep the sentence break after "p.m."
    .replace(/(\d|[AP]M)\s*[–—-]\s*(?=\d|[A-Z][a-z]{2,})/g, "$1 to ") // ranges: 8–3, 2025-26, 7 AM–5 PM, July 1–June 30
    .replace(/\s*[–—]\s*/g, ", ").replace(/&/g, " and ").replace(/(\d)%/g, "$1 percent").replace(/(\w)\s*\/\s*(\w)/g, "$1 or $2")
    .replace(/[*_`#>|]+/g, " ").replace(/^\s*[-•]\s+/gm, "") // markdown leftovers, bullets
    .replace(/\s+/g, " ").trim();
}

/** Text → WAV buffer (24 kHz mono). */
export async function speakWav(text) {
  const tts = await loadTTS();
  const audio = await tts.generate(speechText(text).slice(0, 2000), { voice: VOICE, speed: Number(process.env.TTS_SPEED) || 1 });
  return Buffer.from(audio.toWav());
}
