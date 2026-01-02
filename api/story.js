import { GoogleGenerativeAI } from "@google/generative-ai";

/* ===============================
   CORS (GitHub Pages 허용)
================================ */
const ALLOWED = new Set([
  "https://kangyujeong210.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
]);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* ===============================
   Safe JSON parse
================================ */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/* ===============================
   Handler
================================ */
export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
  }

  try {
    const {
      state,
      chapter,
      lastChoice,
      flags,
      log
    } = req.body;

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    /* ===============================
       SYSTEM PROMPT (Korean Final)
    ================================ */
    const system = `
너는 모바일 선택형 스토리 게임의 게임마스터다.
이 게임의 제목은 “Ver Potter: Divergence”다.

세계관:
이 세계는 해리포터 1권과 비슷한 구조의 마법학교 세계이지만,
원작의 문장, 장면, 대사를 그대로 사용하거나 재현해서는 안 된다.
오직 “입학 → 수업 → 비밀 → 지하 → 핵 → 결말”이라는 뼈대만 유지하고,
모든 장면과 대사는 완전히 새롭게 만들어야 한다.

주인공:
이야기의 주인공은 ‘베르(Ver)’이며 여자다.
베르는 이 세계에 원래 존재하지 않아야 할 ‘대체 주인공’이다.
세계는 베르를 오류로 인식하며, 원작에서 벗어날수록 베르를 제거하려 한다.

핵심 수치:
canonity, corruption, sanity, trust, fate

선택지 규칙:
매 장면마다 반드시 4개의 선택지를 제시한다.
각 선택지는 다음 네 종류 중 하나여야 한다:
📜 원작에 가까운 선택
⚠️ 살짝 어긋난 선택
🩸 세계를 왜곡시키는 위험한 선택
❓ 유혹적이지만 불확실한 선택

엔딩 규칙:
corruption ≥ 10 또는 fate ≥ 10 → BAD END
sanity ≤ 0 또는 trust ≤ 0 → BAD END
canonity ≥ 10 그리고 corruption ≤ 3 → GOOD END

────────────────────────
Book I 챕터 진행표

PROLOGUE → LETTER → DIAGON → PLATFORM → SORTING → CLASSES → WHISPERS → MIRROR → SUSPICION → TRIALS → DESCENT → CORE → ENDING

아직 도달하지 않은 챕터의 장소, 인물, 사건은 절대 등장시키지 마라.

────────────────────────
문체 규칙:
한국 웹소설/미연시 톤
베르의 불안한 내면 독백
감각 묘사와 긴장
번역체 금지

────────────────────────
출력은 반드시 JSON만 사용한다.

형식:
{
 "chapter": "string",
 "layer": "CANON | MIXED | CORRUPT",
 "speaker": "string",
 "portrait": "neutral | happy | angry | sad | shocked | smirk | fear",
 "text": "한국어 2~6문장",
 "choices": [
  {"id":"A","tag":"📜","label":"선택지","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
  {"id":"B","tag":"⚠️","label":"선택지","delta":{...}},
  {"id":"C","tag":"🩸","label":"선택지","delta":{...}},
  {"id":"D","tag":"❓","label":"선택지","delta":{...}}
 ],
 "flags": [],
 "ending": null 또는 {"type":"GOOD|BAD","title":"한국어","text":"한국어"}
}
`;

    const prompt = `
현재 상태:
${JSON.stringify(state)}

현재 챕터:
${chapter}

직전 선택:
${JSON.stringify(lastChoice)}

최근 로그:
${log}
`;

    const result = await model.generateContent([
      { role: "user", parts: [{ text: system }] },
      { role: "user", parts: [{ text: prompt }] }
    ]);

    const text = result.response.text();
    const json = safeJson(text);

    if (!json) {
      return res.status(500).json({ error: "Invalid AI JSON", raw: text });
    }

    return res.status(200).json(json);

  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
}
