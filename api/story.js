// api/story.js
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ===============================
   CORS (임시로 * 허용: 먼저 동작부터)
   - 나중에 origin 제한으로 좁히면 됨
================================ */
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function coerceScene(obj) {
  const fallback = {
    chapter: "PROLOGUE",
    layer: "CANON",
    speaker: "나 (베르)",
    portrait: "neutral",
    text: "베르는 숨을 삼켰다. 이 세계는 분명, 원래의 흐름을 기억하고 있었다.",
    choices: [
      { id: "A", tag: "📜", label: "조용히 상황을 지켜본다", delta: { canonity: +1, corruption: 0, sanity: 0, trust: 0, fate: 0 } },
      { id: "B", tag: "⚠️", label: "조심스럽게 질문한다", delta: { canonity: 0, corruption: +1, sanity: 0, trust: 0, fate: 0 } },
      { id: "C", tag: "🩸", label: "금기를 건드린다", delta: { canonity: -1, corruption: +2, sanity: -1, trust: -1, fate: +1 } },
      { id: "D", tag: "❓", label: "유혹을 따른다", delta: { canonity: 0, corruption: +1, sanity: -1, trust: 0, fate: +1 } }
    ],
    flags: [],
    ending: null
  };

  if (!obj || typeof obj !== "object") return fallback;

  const out = { ...fallback, ...obj };
  if (!Array.isArray(out.choices) || out.choices.length !== 4) out.choices = fallback.choices;

  out.choices = out.choices.map((c, i) => {
    const base = fallback.choices[i];
    return {
      id: c?.id ?? base.id,
      tag: c?.tag ?? base.tag,
      label: c?.label ?? base.label,
      delta: {
        canonity: Number(c?.delta?.canonity ?? base.delta.canonity),
        corruption: Number(c?.delta?.corruption ?? base.delta.corruption),
        sanity: Number(c?.delta?.sanity ?? base.delta.sanity),
        trust: Number(c?.delta?.trust ?? base.delta.trust),
        fate: Number(c?.delta?.fate ?? base.delta.fate)
      }
    };
  });

  if (!Array.isArray(out.flags)) out.flags = [];
  if (out.ending && typeof out.ending !== "object") out.ending = null;

  return out;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST /api/story" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

  try {
    const body = req.body ?? {};
    const state = body.state ?? { canonity: 5, corruption: 0, sanity: 7, trust: 6, fate: 0 };
    const chapter = body.chapter ?? "PROLOGUE";
    const lastChoice = body.lastChoice ?? null;
    const flags = Array.isArray(body.flags) ? body.flags : [];
    const log = typeof body.log === "string" ? body.log.slice(0, 1600) : "";

    const system = `
너는 모바일 선택형 스토리 게임의 게임마스터다.
이 게임의 제목은 “Ver Potter: Divergence”다.

[저작권 안전 규칙]
- 원작의 문장/대사/장면을 그대로 재현하거나 인용하지 마라.
- 1권과 유사한 "구조/분위기"만 참고하고 모든 문장은 새로 작성한다.

[주인공]
- 주인공은 ‘베르(Ver)’이며 여자다.
- 베르는 이 세계에 원래 존재하지 않아야 할 ‘대체 주인공’이다.

[수치]
canonity, corruption, sanity, trust, fate (0~10)

[선택지 규칙]
- 매 장면 선택지 4개 고정:
  A=📜, B=⚠️, C=🩸, D=❓
- 각 선택지는 delta(정수 -3~+3)를 포함한다.

[엔딩 규칙]
corruption ≥ 10 또는 fate ≥ 10 → BAD END
sanity ≤ 0 또는 trust ≤ 0 → BAD END
canonity ≥ 10 그리고 corruption ≤ 3 → GOOD END

[Book I 진행표]
PROLOGUE → LETTER → DIAGON → PLATFORM → SORTING → CLASSES → WHISPERS → MIRROR → SUSPICION → TRIALS → DESCENT → CORE → ENDING
아직 도달하지 않은 챕터의 사건/장소/인물은 미리 등장시키지 마라.

[문체]
한국 웹소설/미연시 톤, 1.5인칭 내면 독백, 감각 묘사, 번역체 금지.

[출력 규칙]
반드시 JSON만 출력. 마크다운/설명 금지.
JSON 스키마:
{
 "chapter":"string",
 "layer":"CANON|MIXED|CORRUPT",
 "speaker":"string",
 "portrait":"neutral|happy|angry|sad|shocked|smirk|fear",
 "text":"한국어 2~6문장",
 "choices":[
  {"id":"A","tag":"📜","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
  {"id":"B","tag":"⚠️","label":"string","delta":{...}},
  {"id":"C","tag":"🩸","label":"string","delta":{...}},
  {"id":"D","tag":"❓","label":"string","delta":{...}}
 ],
 "flags":["string"],
 "ending": null | {"type":"GOOD|BAD","title":"string","text":"string"}
}
`.trim();

    const prompt = `
${system}

[현재 상태]
state=${JSON.stringify(state)}
current_chapter=${chapter}
flags=${JSON.stringify(flags)}
lastChoice=${JSON.stringify(lastChoice)}
log=${log}

지금 current_chapter에 맞는 다음 장면 1개를 생성하라.
JSON만 출력하라.
`.trim();

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const raw = result?.response?.text?.() ?? "";
    const parsed = safeJson(raw);

    if (!parsed) {
      return res.status(500).json({ error: "Invalid AI JSON", raw });
    }

    return res.status(200).json(coerceScene(parsed));
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err?.message ?? err) });
  }
}

