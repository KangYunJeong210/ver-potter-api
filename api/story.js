// api/story.js (FINAL: CORS 안정판 + 한국어 프롬프트 + 챕터 진행표 + 톤 프리셋)
// Vercel Environment Variables: GEMINI_API_KEY 필수

import { GoogleGenerativeAI } from "@google/generative-ai";

/* ===============================
   CORS (GitHub Pages 허용 - 안정판)
   - 허용된 Origin이면 그대로 echo
   - OPTIONS는 204로 즉시 반환
================================ */
const ALLOWED_ORIGINS = [
  "https://kangyujeong210.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

function setCors(req, res) {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ===============================
   Safe JSON parse
================================ */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ===============================
   Minimal schema coerce (failsafe)
================================ */
function coerceScene(obj) {
  const fallback = {
    chapter: "PROLOGUE",
    layer: "CANON",
    speaker: "나 (베르)",
    portrait: "neutral",
    text: "베르는 잠깐 숨을 멈췄다. 이 세계가, 무언가를 숨기고 있는 것 같았다.",
    choices: [
      { id: "A", tag: "📜", label: "조용히 상황을 지켜본다", delta: { canonity: +1, corruption: 0, sanity: 0, trust: 0, fate: 0 } },
      { id: "B", tag: "⚠️", label: "조심스럽게 질문을 던진다", delta: { canonity: 0, corruption: +1, sanity: 0, trust: 0, fate: 0 } },
      { id: "C", tag: "🩸", label: "금기를 건드리는 선택을 한다", delta: { canonity: -1, corruption: +2, sanity: -1, trust: -1, fate: +1 } },
      { id: "D", tag: "❓", label: "달콤한 유혹을 따라간다", delta: { canonity: 0, corruption: +1, sanity: -1, trust: 0, fate: +1 } }
    ],
    flags: [],
    ending: null
  };

  if (!obj || typeof obj !== "object") return fallback;

  const out = { ...fallback, ...obj };

  // choices must be exactly 4
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

/* ===============================
   Main handler
================================ */
export default async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Dev ping (optional): GET shows ok + hint
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST /api/story", allowed: ALLOWED_ORIGINS });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
  }

  try {
    const body = req.body ?? {};
    const state = body.state ?? { canonity: 5, corruption: 0, sanity: 7, trust: 6, fate: 0 };
    const chapter = body.chapter ?? "PROLOGUE";
    const lastChoice = body.lastChoice ?? null;
    const flags = Array.isArray(body.flags) ? body.flags : [];
    const log = typeof body.log === "string" ? body.log.slice(0, 1600) : "";

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    /* ===============================
       System Prompt (Korean + Roadmap + Tone)
    ================================ */
    const system = `
너는 모바일 선택형 스토리 게임의 게임마스터다.
이 게임의 제목은 “Ver Potter: Divergence”다.

[저작권 안전 규칙]
- 이 세계는 해리포터 1권과 "구조/분위기"가 비슷한 마법학교 이야기다.
- 하지만 원작의 문장/대사/장면을 그대로 사용하거나 재현하면 안 된다.
- 오직 “입학 → 수업 → 비밀 → 지하 → 핵 → 결말”이라는 큰 뼈대만 참고하고,
  모든 사건/문장/대사는 완전히 새롭게 만들어야 한다.

[주인공]
- 주인공은 ‘베르(Ver)’이며 여자다.
- 베르는 이 세계에 원래 존재하지 않아야 할 ‘대체 주인공’이다.
- 세계는 베르를 오류로 인식하며, 원작에서 벗어날수록 베르를 제거하려 한다.

[핵심 수치]
canonity(정통성), corruption(오염도), sanity(정신), trust(신뢰), fate(운명)

[선택지 규칙]
- 매 장면마다 반드시 선택지 4개를 제시한다.
- 4개는 반드시 아래 태그와 매칭되어야 한다:
  A=📜(원작에 가까움), B=⚠️(살짝 어긋남), C=🩸(위험한 왜곡), D=❓(유혹/불확실)
- 각 선택지는 반드시 delta(수치 변화)를 포함한다.
- delta는 정수이며 범위는 -3~+3로 제한한다.

[엔딩 규칙]
- corruption ≥ 10 또는 fate ≥ 10 → BAD END
- sanity ≤ 0 또는 trust ≤ 0 → BAD END
- canonity ≥ 10 그리고 corruption ≤ 3 → GOOD END
- 엔딩에 도달하면 ending 필드를 출력하고, 그 장면에서 종료한다.

────────────────────────
[Book I 챕터 진행표]
아래 순서를 절대 어기지 마라.
PROLOGUE → LETTER → DIAGON → PLATFORM → SORTING → CLASSES → WHISPERS → MIRROR → SUSPICION → TRIALS → DESCENT → CORE → ENDING

- 아직 도달하지 않은 챕터의 장소/사건/인물은 절대 미리 등장시키지 마라.
- 챕터는 "의미 있는 사건(단서 획득/관계 변화/위기)" 이후에만 다음으로 넘어간다.

각 챕터의 역할:
PROLOGUE: 베르가 이 세계에 어울리지 않는 존재라는 위화감 암시
LETTER: 초대 사건
DIAGON: 마법 상점/지팡이/도구 소개
PLATFORM: 이동과 동료 첫 만남
SORTING: 소속 결정
CLASSES: 수업과 재능
WHISPERS: 금지 구역/단서
MIRROR: ‘원래 있어야 할 주인공’의 그림자
SUSPICION: 교수/배신 의심
TRIALS: 수호 퍼즐/시험
DESCENT: 지하 진입
CORE: 마법의 핵 대면
ENDING: 수치 기반 결말

────────────────────────
[문체/톤]
- 한국 웹소설/미연시 톤, 번역체 금지
- 1.5인칭(베르의 내면 독백이 섞인 시점)
- 감각(온도/소리/거리/시선)과 긴장감 묘사
- 베르의 불안, 직감, 죄책감이 자주 스며들어야 한다.
- 대사는 현실적인 말투

[캐릭터 말투]
- 동료 소녀(헤르미온느 계열): 빠르고 논리적. 오염 높으면 규칙을 쉽게 버린다.
- 동료 소년(론 계열): 솔직하고 감정적. 오염 높으면 질투/의심이 강해진다.
- 의심스러운 교수: 공손하지만 질문으로 압박. 오염 높으면 냉소/위협.
- 거울 속 그림자: 짧고 서늘. “너는 여기에 없어야 했어” 같은 메타적 문장.

────────────────────────
[출력 규칙]
- 반드시 JSON만 출력한다. 설명/마크다운/주석 금지.
- text는 한국어 2~6문장.
- choices는 반드시 4개.
- layer는 CANON|MIXED|CORRUPT 중 하나.

[JSON 형식]
{
 "chapter": "string",
 "layer": "CANON|MIXED|CORRUPT",
 "speaker": "string",
 "portrait": "neutral|happy|angry|sad|shocked|smirk|fear",
 "text": "string",
 "choices": [
   {"id":"A","tag":"📜","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
   {"id":"B","tag":"⚠️","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
   {"id":"C","tag":"🩸","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
   {"id":"D","tag":"❓","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}}
 ],
 "flags": ["string"],
 "ending": null | {"type":"GOOD|BAD","title":"string","text":"string"}
}
`.trim();

    /* ===============================
       Prompt (state + chapter + lastChoice + flags + log)
    ================================ */
    const prompt = `
[현재 상태]
state=${JSON.stringify(state)}

[current_chapter]
${chapter}

[flags]
${JSON.stringify(flags)}

[직전 선택]
${JSON.stringify(lastChoice)}

[최근 로그 요약]
${log}
`.trim();

    // Gemini 호출
    const result = await model.generateContent([
      { role: "user", parts: [{ text: system }] },
      { role: "user", parts: [{ text: prompt }] }
    ]);

    const raw = result?.response?.text?.() ?? "";
    const parsed = safeJson(raw);

    if (!parsed) {
      // JSON이 아니면 raw를 함께 반환해서 디버깅 가능하게
      return res.status(500).json({ error: "Invalid AI JSON", raw });
    }

    const scene = coerceScene(parsed);
    return res.status(200).json(scene);
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err?.message ?? err) });
  }
}
