import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { ExtractionOutput, GEMINI_RESPONSE_SCHEMA } from "./schema";
import type { ExtractedRegulation } from "./schema";

const EXTRACT_PROMPT = (country: string, title: string, url: string) => `
당신은 화장품 규제 데이터 추출 전문가입니다. 아래 공식 규제 문서(${country})에서 언급된 모든 화장품 원료와 그 규제 내용을 추출하세요.

문서 제목: ${title}
출처 URL: ${url}

**엄격한 규칙**:
1. 문서 원문에 명시된 내용만 추출. 추측·보간 금지. 불명확하면 해당 항목 스킵.
2. inci_name은 국제 INCI 표준명(영문). 문서가 로컬 언어로만 쓰였다면 korean_name / chinese_name / japanese_name 중 해당 언어 필드에 채우고 INCI명도 표준명으로 변환.
2-a. **원문 언어와 무관하게**, 확신할 수 있는 표준 한글명(식약처 공정서)·중국어명(IECIC/GB)·일본어명(MHLW)이 있으면 각 필드에 채우세요. 확신 없으면 null. 추측 금지.
3. status 값 의미:
   - banned: 배합금지 / 사용금지
   - restricted: 배합한도·조건부 허용
   - allowed: 일반 허용 (positive list 없는 국가에서)
   - listed: positive list(예: IECIC, EU Annex V 보존제) 수록 — 수출 가능 근거
   - not_listed: positive list 미수록 — 수출 불가 근거
4. max_concentration은 숫자만. 단위는 concentration_unit에 별도 표기(기본 %).
5. product_categories: leave_on / rinse_off / lip / eye_area / oral_care / aerosol / 등 문서에 명시된 대로.
6. conditions: 자유 텍스트로 제한 조건(예: "헹궈내는 제품만 허용", "점막 사용 금지").
7. source_section: 원문의 해당 조항·별표·페이지 참조(있으면).

**중요**: 1건이라도 불확실하면 전체 배열을 비워서 반환하세요. 잘못된 데이터가 DB에 들어가는 것보다 0건이 낫습니다.
`;

// --- 무료 티어(약 10 RPM · 250k TPM) 보호용 전역 rate limit ---
// 모든 Gemini 호출을 최소 간격으로 띄워 RPM 초과를 사전 차단. TPM(분당 토큰) 초과는
// callWithRetry 가 RESOURCE_EXHAUSTED 감지 시 1분 창이 리셋될 때까지 대기·재시도하여 흡수.
// → 유료 전환 없이 무료 한도 내에서 (느리지만) 확실히 완주.
const MIN_CALL_SPACING_MS = Number(process.env.GEMINI_MIN_SPACING_MS ?? 6_500); // ≈ 9 RPM
let lastCallAt = 0;
async function rateLimitGate() {
  const wait = lastCallAt + MIN_CALL_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function callWithRetry<T>(fn: () => Promise<T>, maxAttempts = 8): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const quota = /\b(429|RESOURCE_EXHAUSTED)\b/.test(msg);
      const transient = /\b(500|502|503|504|UNAVAILABLE)\b/.test(msg);
      // 일일(RPD) quota 소진은 분당창 리셋으로 안 풀림(하루 단위 — PT 자정 리셋). 65초×8 재시도는
      // 순수 낭비(#37 실측: 문서당 ~8.7분 헛돎) → 즉시 throw 해 run.ts circuit-breaker 를 빠르게 트립.
      // RPM/TPM(분당) 만 65초 대기로 회복 가능. quotaId 의 "PerDay" 로 일일 한도를 구분.
      // 정밀 신호 = quotaId 의 "PerDay"(GenerateRequestsPerDayPerProjectPerModel-FreeTier).
      // RPM(분당)은 PerMinute quotaId 라 매칭 안 됨 → 65초 재시도 유지(분당창 회복 가능).
      const dailyQuota = quota && /PerDay/i.test(msg);
      if ((!quota && !transient) || dailyQuota || attempt === maxAttempts) throw e;
      // 무료 TPM/RPM 한도 초과(quota)는 분당 창이 리셋돼야 풀리므로 65초 대기.
      // 일시적 5xx 는 지수 백오프.
      const backoffMs = quota ? 65_000 : Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      console.log(`    · retry ${attempt}/${maxAttempts - 1} after ${backoffMs}ms (${msg.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

function buildContents(filePath: string, prompt: string, raw: Buffer) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    return [
      {
        role: "user" as const,
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "application/pdf", data: raw.toString("base64") } },
        ],
      },
    ];
  }
  // HTML, CSV, text — pass as text payload
  return [
    {
      role: "user" as const,
      parts: [{ text: `${prompt}\n\n<<<DOCUMENT START>>>\n${raw.toString("utf8")}\n<<<DOCUMENT END>>>` }],
    },
  ];
}

export async function extractWithModel(args: {
  model: string;
  filePath: string;
  country: string;
  title: string;
  url: string;
}): Promise<ExtractedRegulation[]> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const raw = await readFile(args.filePath);
  const prompt = EXTRACT_PROMPT(args.country, args.title, args.url);

  const res = await callWithRetry(async () => {
    await rateLimitGate(); // 매 시도(재시도 포함)마다 호출 간격 보장
    return ai.models.generateContent({
      model: args.model,
      contents: buildContents(args.filePath, prompt, raw),
      config: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        temperature: 0,
      },
    });
  });

  const text = res.text ?? "";
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Model ${args.model} returned non-JSON: ${text.slice(0, 200)}`);
  }

  const result = ExtractionOutput.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Model ${args.model} output failed schema validation: ${result.error.message}`,
    );
  }
  return result.data.regulations;
}
