// api/story.js
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ===============================
   CORS (임시로 * 허용: 먼저 동작부터)
================================ */
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function clamp(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeJson(text) {
  if (!text) return null;

  let t = String(text).trim();
  // ```json 제거
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // 첫 { ~ 마지막 } 추출
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  t = t.slice(first, last + 1).trim();

  try {
    return JSON.parse(t);
  } catch {
    // 이중 문자열 케이스
    try {
      const unquoted = JSON.parse(t);
      if (typeof unquoted === "string") return JSON.parse(unquoted);
    } catch {}
    return null;
  }
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
      { id: "B", tag: "⚠️", label: "조심스럽게 탐색한다", delta: { canonity: 0, corruption: 0, sanity: -1, trust: +1, fate: 0 } },
      { id: "C", tag: "🩸", label: "금기를 건드린다", delta: { canonity: -2, corruption: +2, sanity: -1, trust: -1, fate: +1 } },
      { id: "D", tag: "❓", label: "유혹을 따른다", delta: { canonity: -1, corruption: +1, sanity: -1, trust: 0, fate: +2 } }
    ],
    flags: [],
    ending: null
  };

  if (!obj || typeof obj !== "object") return fallback;

  const out = { ...fallback, ...obj };

  if (!Array.isArray(out.choices) || out.choices.length !== 4) out.choices = fallback.choices;

  out.choices = out.choices.map((c, i) => {
    const base = fallback.choices[i];
    const d = c?.delta ?? {};
    return {
      id: c?.id ?? base.id,
      tag: c?.tag ?? base.tag,
      label: (c?.label ?? base.label)?.toString().slice(0, 60),
      delta: {
        canonity: clamp(d.canonity ?? base.delta.canonity, -3, 3),
        corruption: clamp(d.corruption ?? base.delta.corruption, -3, 3),
        sanity: clamp(d.sanity ?? base.delta.sanity, -3, 3),
        trust: clamp(d.trust ?? base.delta.trust, -3, 3),
        fate: clamp(d.fate ?? base.delta.fate, -3, 3)
      }
    };
  });

  if (!Array.isArray(out.flags)) out.flags = [];
  out.flags = out.flags.map(String).slice(0, 24);

  if (out.ending && typeof out.ending !== "object") out.ending = null;

  // text 너무 길면 속도/가독성 떨어짐 → 제한
  out.text = String(out.text ?? fallback.text).slice(0, 520);

  return out;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method === "GET") return res.status(200).json({ ok: true, hint: "POST /api/story" });
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

  try {
    // ✅ Vercel에서 req.body가 문자열로 들어오는 케이스 방지
    let body = req.body ?? {};
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const state = body.state ?? { canonity: 5, corruption: 0, sanity: 7, trust: 6, fate: 0 };
    const chapter = (body.chapter ?? "PROLOGUE").toString();
    const lastChoice = body.lastChoice ?? null;
    const flags = Array.isArray(body.flags) ? body.flags : [];
    const logRaw = typeof body.log === "string" ? body.log : "";

    // ✅ 로그는 "최근만" + chars 제한(너무 길면 느림/반복↑)
    const recentLog = logRaw
      .split("\n")
      .slice(-10)                // 최근 10줄만
      .join("\n")
      .slice(0, 900);            // 최대 900자

    // ✅ lastChoice 정리(연결 강제에 쓰일 값)
    const lcLabel = lastChoice?.label ? String(lastChoice.label).slice(0, 80) : "";
    const lcTag = lastChoice?.tag ? String(lastChoice.tag) : "";
    const lcId = lastChoice?.id ? String(lastChoice.id) : "";

    const system = `
너는 모바일 선택형 스토리 게임의 게임마스터다.
이 게임의 제목은 “Ver Potter: Divergence”다.

[저작권 안전 규칙]
- 원작의 문장/대사/고유 대사를 그대로 재현/인용하지 마라.
- 1권과 유사한 구조/분위기만 참고하고 문장은 전부 새로 작성한다.

[절대 규칙: 진행 속도 & 반복 방지]
- 플레이어에게 질문하지 마라. 확인/되묻기/설명/사과/메타발화 금지.
- 매 턴 반드시 '사건 1개'를 진전시켜라(정보 공개/장소 이동/관계 변화/위험 상승 중 1개).
- 최근 3턴과 동일한 도입 문장(첫 문장) 패턴을 재사용하지 마라.
- 선택지 4개는 서로 의미가 겹치지 않게(중복 선택지 금지).

[연결 강제]
- lastChoice.label이 비어있지 않다면:
  다음 장면의 첫 문장에 lastChoice.label의 “행동 결과”를 반드시 반영해라.
- lastChoice.label이 비어있다면:
  PROLOGUE 첫 장면처럼 자연스럽게 시작하되, 질문은 하지 마라.

[주인공]
- 주인공은 ‘베르(Ver)’이며 여자다. 대체 주인공.
- 1.5인칭(내면독백 포함) 유지.

[수치] canonity, corruption, sanity, trust, fate (0~10)

[선택지 규칙]
- 매 장면 선택지 4개 고정: A=📜, B=⚠️, C=🩸, D=❓
- 각 선택지는 delta(정수 -3~+3)를 포함한다.
- delta는 장면 분위기/심리/관계에 반영되게 묘사하라(짧게).

[엔딩 규칙]
corruption ≥ 10 또는 fate ≥ 10 → BAD END
sanity ≤ 0 또는 trust ≤ 0 → BAD END
canonity ≥ 10 그리고 corruption ≤ 3 → GOOD END

[Book I 진행표]
PROLOGUE → LETTER → DIAGON → PLATFORM → SORTING → CLASSES → WHISPERS → MIRROR → SUSPICION → TRIALS → DESCENT → CORE → ENDING
아직 도달하지 않은 챕터의 사건/장소/인물은 미리 등장시키지 마라.

[문체]
한국 웹소설/미연시 톤. 번역체 금지. 감각 묘사 짧고 선명하게.

[출력 규칙]
반드시 JSON만 출력. 코드블록/마크다운/설명 금지.
text는 2~5문장(짧게).
선택지는 4개 고정.
delta는 -3~+3 범위.
`.trim();

    const memory = [
      "베르=여자/대체 주인공. 원래 흐름에 균열이 생김.",
      `현재 챕터=${chapter}. (이후 챕터 요소 금지)`,
      `수치: canonity=${state.canonity}, corruption=${state.corruption}, sanity=${state.sanity}, trust=${state.trust}, fate=${state.fate}`,
      `flags=${JSON.stringify(flags).slice(0, 260)}`
    ].join("\n");

    const prompt = `
${system}

[메모리]
${memory}

[최근 로그]
${recentLog || "(없음)"}

[직전 선택]
id=${lcId} tag=${lcTag} label=${lcLabel || "(없음)"}

[요청]
- current_chapter="${chapter}"에 맞는 다음 장면 1개 생성
- 첫 문장에 (label이 있으면) 반드시 결과 반영
- 반드시 아래 스키마로 JSON만 출력:

{
 "chapter":"${chapter}",
 "layer":"CANON|MIXED|CORRUPT",
 "speaker":"string",
 "portrait":"neutral|happy|angry|sad|shocked|smirk|fear",
 "text":"한국어 2~5문장",
 "choices":[
  {"id":"A","tag":"📜","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
  {"id":"B","tag":"⚠️","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
  {"id":"C","tag":"🩸","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
  {"id":"D","tag":"❓","label":"string","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}}
 ],
 "flags":["string"],
 "ending": null | {"type":"GOOD|BAD","title":"string","text":"string"}
}
`.trim();

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 650
      }
    });

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
