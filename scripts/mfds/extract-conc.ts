// MFDS 조건 텍스트에서 '단일' 최대농도(%)만 결정론적 추출.
// 모든 '최대 농도' 블록의 값을 모아 정확히 1개일 때만 반환 — 다중값/모호/없음은 null(안전).
// (제품 유형·부위별로 다른 다중 한도를 단일 숫자로 잘못 표기하지 않기 위함.)
export function extractMaxConc(conditions: string | null | undefined): number | null {
  if (!conditions) return null;
  const segs = [...conditions.matchAll(/최대\s*농도\s*[:：]\s*([^*<]*?)(?:\n\s*\*|\n<|$)/g)].map((m) => m[1]);
  if (!segs.length) return null;
  const vals = [...new Set(segs.flatMap((s) => [...s.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((x) => x[1])))];
  if (vals.length !== 1) return null;
  const n = Number(vals[0]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}
