import { extractWithModel } from "./extractor";
import { GEMINI_PRIMARY } from "../gemini-models";
import type { ExtractedRegulation } from "./schema";

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
