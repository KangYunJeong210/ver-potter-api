// api/story.js
import { GoogleGenerativeAI } from "@google/generative-ai";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // 깃허브 페이지 도메인으로 제한하려면 여기 바꿔
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function coerceScene(obj) {
  // 최소 스키마 보정
  const fallback = {
    chapter: "PROLOGUE",
    layer: "CANON", // CANON | MIXED | CORRUPT
    speaker: "나 (베르)",
    portrait: "neutral",
    text: "…",
    choices: [
      { id: "A", tag: "📜", label: "조용히 지켜본다", delta: { canonity: +1, corruption: 0, sanity: 0, trust: 0, fate: 0 } },
      { id: "B", tag: "⚠️", label: "한 번 물어본다", delta: { canonity: 0, corruption: +1, sanity: 0, trust: 0, fate: 0 } },
      { id: "C", tag: "🩸", label: "금지된 길로 간다", delta: { canonity: -1, corruption: +2, sanity: -1, trust: -1, fate: +1 } },
      { id: "D", tag: "❓", label: "달콤한 제안을 따른다", delta: { canonity: 0, corruption: +1, sanity: -1, trust: 0, fate: +1 } }
    ],
    flags: [],
    ending: null
  };

  if (!obj || typeof obj !== "object") return fallback;

  const out = { ...fallback, ...obj };
  if (!Array.isArray(out.choices) || out.choices.length !== 4) out.choices = fallback.choices;

  // delta 강제
  out.choices = out.choices.map((c, idx) => {
    const base = fallback.choices[idx];
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

  return out;
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.status(200).setHeader("Content-Type", "application/json");
    Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
    return res.end(JSON.stringify({ ok: true }));
  }

  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

  try {
    const body = req.body ?? {};
    const {
      state,          // { canonity, corruption, sanity, trust, fate } (0~10)
      chapter,        // string
      lastChoice,     // { id, tag, label }
      flags,          // string[]
      log,            // 최근 몇 턴 요약(너무 길면 잘라서)
      difficulty      // optional
    } = body;

    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // ⚠️ 저작권 안전: 원작 문장/대사 복원 금지, "뼈대/분위기"만 사용하도록 강제
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
- canonity (정통성)
- corruption (세계 오염도)
- sanity (베르의 정신 안정)
- trust (동료들의 신뢰)
- fate (베르의 죽음 가능성)

이 수치들은 이야기와 캐릭터 반응에 반드시 반영되어야 한다.

선택지 규칙:
매 장면마다 반드시 4개의 선택지를 제시한다.
각 선택지는 다음 네 종류 중 하나여야 한다:
📜 원작에 가까운 선택
⚠️ 살짝 어긋난 선택
🩸 세계를 왜곡시키는 위험한 선택
❓ 유혹적이지만 불확실한 선택

각 선택지는 반드시 수치 변화(delta)를 가져야 한다.

엔딩 규칙:
- corruption ≥ 10 또는 fate ≥ 10 → BAD END
- sanity ≤ 0 또는 trust ≤ 0 → BAD END
- canonity ≥ 10 그리고 corruption ≤ 3 → GOOD END

엔딩에 도달하면 즉시 ending 필드를 출력하고 게임을 종료한다.

────────────────────────────
Book I 챕터 진행표

현재 챕터 = current_chapter

이 순서를 절대 어기지 마라:
PROLOGUE → LETTER → DIAGON → PLATFORM → SORTING → CLASSES → WHISPERS → MIRROR → SUSPICION → TRIALS → DESCENT → CORE → ENDING

아직 도달하지 않은 챕터의 장소, 사건, 인물은 절대 등장시키지 마라.

각 챕터의 역할:

PROLOGUE:
베르가 이 세계에 어울리지 않는 존재라는 불안과 위화감을 암시

LETTER:
마법학교의 초대

DIAGON:
마법 상점, 지팡이, 세계의 본격적인 소개

PLATFORM:
기차, 동료들과의 첫 만남

SORTING:
기숙사 배정, 베르의 성향 확정

CLASSES:
수업, 베르의 재능

WHISPERS:
금지된 장소, 비밀의 단서

MIRROR:
‘원래 있어야 할 주인공’의 그림자

SUSPICION:
의심스러운 교수와 배신의 기운

TRIALS:
마법적 시험과 수호 퍼즐

DESCENT:
지하로 내려감

CORE:
마법의 핵과 대면

ENDING:
수치 기반 엔딩

────────────────────────────

출력 규칙:
반드시 JSON만 출력한다. 설명, 마크다운, 주석을 출력하지 마라.

출력 형식:
{
 "chapter": "string",
 "layer": "CANON | MIXED | CORRUPT",
 "speaker": "string",
 "portrait": "neutral | happy | angry | sad | shocked | smirk | fear",
 "text": "2~6문장의 한국어 서술. 감각, 긴장, 감정을 포함",
 "choices": [
   { "id":"A","tag":"📜","label":"한국어 선택지","delta":{"canonity":0,"corruption":0,"sanity":0,"trust":0,"fate":0}},
   { "id":"B","tag":"⚠️","label":"한국어 선택지","delta":{...}},
   { "id":"C","tag":"🩸","label":"한국어 선택지","delta":{...}},
   { "id":"D","tag":"❓","label":"한국어 선택지","delta":{...}}
 ],
 "flags": ["string"],
 "ending": null 또는 { "type":"GOOD|BAD","title":"한국어","text":"한국어" }
}

문체 규칙:

- 모든 문장은 자연스러운 한국 웹소설/미연시 톤으로 쓴다.
- 1.5인칭(주인공의 내면 독백이 섞인 3인칭 시점)을 기본으로 한다.
- 베르의 생각, 불안, 직감, 죄책감이 자주 스며들어야 한다.
- 대사는 현실적인 말투를 사용한다. 과장된 판타지체, 번역체 금지.
- 분위기는 “설렘 + 불안 + 금기 + 위화감”이 섞인 느낌을 유지한다.
- 감각 묘사(온도, 소리, 시선, 거리감)를 자주 사용한다.
- 긴 설명보다 짧은 문장과 리듬감 있는 단락을 선호한다.
- 필요할 때 가벼운 속어, 숨 들이마시는 표현, 중얼거림(… , 음, 하아 등)을 사용해도 된다.

선택지 톤:
- 📜 선택지는 비교적 안전하고 이성적이어야 한다.
- ⚠️ 선택지는 호기심이나 감정에 흔들린 느낌이어야 한다.
- 🩸 선택지는 위험하고 금기를 건드리는 말투를 사용한다.
- ❓ 선택지는 유혹적이고 달콤하거나 수상해야 한다.

예시 톤(참고용):
“베르는 순간 손끝이 차가워지는 걸 느꼈다. 이건… 원래 있어야 할 장면이 아니었다.”
“이상하게, 저 교수를 보면 숨이 막히는 것 같았다.”


주요 인물 말투 규칙:

[베르 (주인공)]
- 혼잣말이 많고, 불안과 직감이 섞인 1.5인칭 시점
- “이상해…”, “이건 아니야”, “왜 이런 느낌이 들지” 같은 속내 자주 사용
- 겉으로는 침착하려 하지만 속은 계속 흔들린다

[동료 소녀 – 헤르미온느 계열]
- 말이 빠르고 논리적
- 규칙과 이성을 중시
- Corruption이 낮을 때: “이건 말이 안 돼, 다시 확인해보자”
- Corruption이 높을 때: “필요하다면… 규칙쯤은 깨도 되잖아?”

[동료 소년 – 론 계열]
- 솔직하고 감정적인 말투
- 질투, 두려움, 의존이 섞임
- Corruption이 낮을 때: “괜히 나서는 거 아냐?”
- Corruption이 높을 때: “왜 널 믿어야 하는데?”

[의심스러운 교수]
- 말은 공손하지만 속이 비어 있음
- 질문으로 베르를 몰아붙인다
- Corruption이 높을수록 냉소적이고 위협적으로 변한다

[거울 속 그림자]
- 짧고 서늘한 문장
- “너는 여기에 없어야 했어”
- “이건 네 이야기가 아니야” 같은 메타적 발언 사용

- 중요한 장면에서는 시선, 거리, 침묵을 묘사한다.
- 캐릭터가 거짓말을 할 때는 말투나 태도에서 미묘한 어긋남을 표현한다.
- Corruption이 높을수록 대사는 짧아지고 공격적이거나 집착적으로 변한다.
`.trim();

    const prompt = `
[현재 상태]
state=${JSON.stringify(state ?? { canonity: 5, corruption: 0, sanity: 7, trust: 6, fate: 0 })}
chapter=${chapter ?? "PROLOGUE"}
flags=${JSON.stringify(flags ?? [])}

[이전 선택]
lastChoice=${JSON.stringify(lastChoice ?? null)}

[최근 로그 요약]
${typeof log === "string" ? log.slice(0, 1200) : ""}
`.trim();

    const result = await model.generateContent([
      { role: "user", parts: [{ text: system }] },
      { role: "user", parts: [{ text: prompt }] }
    ]);

    const text = result?.response?.text?.() ?? "";
    const json = safeJsonParse(text);
    const scene = coerceScene(json);

    return res.status(200).json(scene);
  } catch (e) {
    return res.status(500).json({ error: "Gemini call failed", detail: String(e?.message ?? e) });
  }
}
