import { dataset } from "./data-loader";

export interface Suggestion {
  inci_name: string;
  korean_name: string | null;
  cas_no: string | null;
}

function sanitize(s: string): string {
  return s.replace(/[,()%_\\"]/g, " ").replace(/\s+/g, " ").trim();
}

export async function fetchSuggestions(rawQuery: string, signal?: AbortSignal): Promise<Suggestion[]> {
  const raw = rawQuery.trim();
  if (raw.length === 0 || raw.length > 128) return [];
  const safe = sanitize(raw).toLowerCase();
  if (safe.length < 1) return [];

  const ds = await dataset();
  if (signal?.aborted) return [];

  const results: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (ing: { inci_name: string; korean_name: string | null; cas_no: string | null }) => {
    if (results.length >= 8 || seen.has(ing.inci_name)) return;
    seen.add(ing.inci_name);
    results.push({ inci_name: ing.inci_name, korean_name: ing.korean_name, cas_no: ing.cas_no });
  };
  // CAS 질의(숫자-대시) 여부 — 검색(lookupRegulation)이 CAS 를 해석하므로 자동완성도 지원(F7).
  const isCasQuery = /^\d{1,7}-?\d{0,2}-?\d?$/.test(raw.replace(/\s/g, ""));
  const rawCas = raw.replace(/\s/g, "");

  // 1) Korean prefix  2) INCI prefix — prefix 매칭 우선.
  for (const ing of ds.ingredients) {
    if (results.length >= 8) break;
    if (signal?.aborted) return [];
    if (ing.korean_name && ing.korean_name.toLowerCase().startsWith(safe)) add(ing);
  }
  for (const ing of ds.ingredients) {
    if (results.length >= 8) break;
    if (signal?.aborted) return [];
    if (ing.inci_name && ing.inci_name.toLowerCase().startsWith(safe)) add(ing);
  }
  // 3) CAS prefix (CAS 형태 질의일 때만)  4) 중문/일문 substring — 검색 커버리지와 일치(F7).
  if (results.length < 8) {
    for (const ing of ds.ingredients) {
      if (results.length >= 8) break;
      if (signal?.aborted) return [];
      if (isCasQuery && ing.cas_no && ing.cas_no.split(/\s+/).some((c) => c.trim().startsWith(rawCas))) add(ing);
      else if (!isCasQuery && ((ing.chinese_name && ing.chinese_name.includes(raw)) || (ing.japanese_name && ing.japanese_name.includes(raw)))) add(ing);
    }
  }
  // 5) synonym substring — 통용명("Bronopol" 등) 자동완성. 이름/CAS 결과가 부족할 때만 보충(additive).
  if (results.length < 8 && !isCasQuery) {
    for (const ing of ds.ingredients) {
      if (results.length >= 8) break;
      if (signal?.aborted) return [];
      if (ing.synonyms && ing.synonyms.some((s) => s.toLowerCase().includes(safe))) add(ing);
    }
  }

  return results;
}
