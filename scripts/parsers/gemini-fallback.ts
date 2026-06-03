import { randomUUID } from "node:crypto";
import { extractWithModel } from "./extractor";
import { GEMINI_PRIMARY } from "../gemini-models";
import type { ExtractedRegulation } from "./schema";

// fetcher 들의 ingredient/regulation row 는 구조적으로 동일 → 공용 타입.
export interface FallbackIngredientRow {
  id: string;
  inci_name: string;
  korean_name: string | null;
  chinese_name: string | null;
  japanese_name: string | null;
  cas_no: string | null;
  synonyms: string[];
  description: string | null;
  function_category: string | null;
  function_description: string | null;
}
export interface FallbackRegulationRow {
  ingredient_id: string;
  country_code: string;
  status: string;
  max_concentration: number | null;
  concentration_unit: string;
  product_categories: string[];
  conditions: string | null;
  source_url: string | null;
  source_document: string;
  source_version: string | null;
  source_priority: number;
  last_verified_at: string;
  confidence_score: number;
  override_note: string | null;
}

// Gemini 폴백 결과(ExtractedRegulation[]) → RegulationRow[]. 신규 ingredient 는
// ingredients 배열에 push(inci_name 소문자 매칭). 모든 fetcher 의 폴백 분기에서 공용.
// 폴백 행은 정규식(priority 100·confidence 1.0)보다 낮은 priority 80·confidence 0.75 로
// 구분 — 정규식이 복구되면 그 행으로 자연 교체됨.
export function buildRegsFromExtracted(opts: {
  regs: ExtractedRegulation[];
  ingredients: FallbackIngredientRow[];
  country: string;
  sourceDoc: string;
  sourceUrl: string;
  now: string;
  sourcePriority?: number;
}): FallbackRegulationRow[] {
  const { regs, ingredients, country, sourceDoc, sourceUrl, now } = opts;
  const priority = opts.sourcePriority ?? 80;
  const byInci = new Map<string, FallbackIngredientRow>();
  for (const i of ingredients) byInci.set(i.inci_name.toLowerCase(), i);
  const out: FallbackRegulationRow[] = [];
  for (const r of regs) {
    if (!r.inci_name || r.status === "not_listed") continue;
    const key = r.inci_name.toLowerCase();
    let ing = byInci.get(key);
    if (!ing) {
      ing = {
        id: randomUUID(),
        inci_name: r.inci_name,
        korean_name: r.korean_name ?? null,
        chinese_name: r.chinese_name ?? null,
        japanese_name: r.japanese_name ?? null,
        cas_no: r.cas_no ?? null,
        synonyms: r.synonyms ?? [],
        description: null,
        function_category: null,
        function_description: null,
      };
      ingredients.push(ing);
      byInci.set(key, ing);
    }
    out.push({
      ingredient_id: ing.id,
      country_code: country,
      status: r.status,
      max_concentration: r.max_concentration ?? null,
      concentration_unit: r.concentration_unit ?? "%",
      product_categories: r.product_categories ?? [],
      conditions: r.conditions ?? `${sourceDoc} — Gemini 폴백 자동 파싱`,
      source_url: sourceUrl,
      source_document: sourceDoc,
      source_version: `gemini-fallback-${now.slice(0, 10)}`,
      source_priority: priority,
      last_verified_at: now,
      confidence_score: 0.75,
      override_note: "정규식 0건 → Gemini 폴백 (소스 양식 변경 추정)",
    });
  }
  return out;
}

// 정규식 파서가 0건을 반환할 때(=소스 양식이 바뀐 신호)에만 호출하는 Gemini 폴백.
// 문서(filePath: PDF/HTML/text)를 Gemini 로 1회 파싱해 ExtractedRegulation[] 반환.
//
// 부작용 0 보장:
//  - 호출부는 반드시 "정규식 0건일 때만" 호출 → 정상 경로는 이 코드를 안 탐.
//  - 키 없음·실패·0건이면 빈 배열 반환 → 호출부의 기존 "0건 보존" 가드로 그대로 진행.
//  - extractor 의 rate gate/backoff 가 무료 티어 한도를 지킴(드물게 발동하므로 영향 미미).
export async function geminiRescue(args: {
  filePath: string;
  country: string;
  title: string;
  url: string;
}): Promise<ExtractedRegulation[]> {
  if (!process.env.GEMINI_API_KEY) {
    console.log("  ⊘ Gemini 폴백 skip — GEMINI_API_KEY 없음 (기존 데이터 보존)");
    return [];
  }
  try {
    console.log(`  ▶ 정규식 0건 → Gemini 폴백 시도 (${args.filePath})`);
    const regs = await extractWithModel({ model: GEMINI_PRIMARY, ...args });
    console.log(`  ◀ Gemini 폴백 결과: ${regs.length}건`);
    return regs;
  } catch (e) {
    console.error(`  ✗ Gemini 폴백 실패(무시·기존 데이터 보존): ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
