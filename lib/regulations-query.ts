import { dataset, type Ingredient, type Regulation, type KciaArticle, type SourcePdf } from "./data-loader";

// 인메모리 검색 — Phase 5: Supabase 의존 제거.
// public/data/*.json (브라우저 ETag 자동 비교) 의 인덱스만 사용.

export type LookupSource = "verified" | "pending" | "not_found";
export type RegulationType = "negative_list" | "positive_list" | "hybrid";

// 같은 country 에 cascade fallback (1안→2안→3안) 으로 여러 source 가 쌓일 수 있음.
// 메인 status 는 priority desc 첫번째(1차) 기준. all_sources 는 보조 출처 포함 전체 목록.
export interface SourceRef {
  source_document: string | null;
  source_url: string | null;
  source_priority: number | null;  // 100=공식 1차, 80=KCIA Gemini auto, 50=MFDS 등
  status: "banned" | "restricted" | "allowed" | "listed" | "not_listed" | string | null;
  max_concentration: number | null;
  concentration_unit: string | null;
  conditions: string | null;
  last_verified_at: string | null;
  confidence_score: number | null;
}

export interface CountryLookupResult {
  country_code: string;
  country_name_ko: string;
  regulation_type: RegulationType;
  registry_url?: string | null;
  registry_name?: string | null;
  source: LookupSource;
  status?: "banned" | "restricted" | "allowed" | "listed" | "not_listed";
  max_concentration?: number | null;
  concentration_unit?: string | null;
  product_categories?: string[];
  conditions?: string | null;
  source_url?: string | null;
  source_document?: string | null;
  source_priority?: number | null;  // 메인 source 의 priority (UI 가 cascade 단계 표시)
  confidence_score?: number | null;
  last_verified_at?: string;
  pending_reason?: string;
  inherits_from?: string | null;
  override_note?: string | null;
  kcia_articles?: KciaArticle[];
  source_pdfs?: SourcePdf[];
  all_sources?: SourceRef[];  // priority desc 정렬 — 모든 출처 (1안+2안+3안)
}

export interface IngredientMatch {
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

export interface LookupResponse {
  query: string;
  ingredient: IngredientMatch | null;
  results: CountryLookupResult[];
}

function sanitize(s: string): string {
  return s.replace(/[,()%_\\"]/g, " ").trim();
}

function findIngredientSync(
  query: string,
  ds: Awaited<ReturnType<typeof dataset>>,
): Ingredient | null {
  const safe = sanitize(query).toLowerCase();
  if (!safe) return null;

  // 1) exact INCI
  const inci = ds.ingredientByInciLower.get(safe);
  if (inci) return inci;

  // 2) exact Korean
  const kor = ds.ingredientByKoreanLower.get(safe);
  if (kor) return kor;

  // 3) CAS 정확 매칭 (CAS 형식만)
  if (/^\d{1,7}-\d{2}-\d$/.test(query.trim())) {
    const cas = ds.ingredientByCas.get(query.trim());
    if (cas) return cas;
  }

  // 4) substring 검색 — INCI / Korean / Chinese / Japanese
  for (const ing of ds.ingredients) {
    if (ing.inci_name && ing.inci_name.toLowerCase().includes(safe)) return ing;
    if (ing.korean_name && ing.korean_name.toLowerCase().includes(safe)) return ing;
    if (ing.chinese_name && ing.chinese_name.includes(query)) return ing;
    if (ing.japanese_name && ing.japanese_name.includes(query)) return ing;
  }
  return null;
}

export async function lookupRegulation(
  query: string,
  countries?: string[],
): Promise<LookupResponse> {
  const ds = await dataset();
  const q = query.trim();
  if (!q) return { query: q, ingredient: null, results: [] };

  const ingredient = findIngredientSync(q, ds);
  if (!ingredient) return { query: q, ingredient: null, results: [] };

  const targetCodes = countries && countries.length > 0
    ? countries
    : ds.countries.map((c) => c.code);

  // F5: 같은 물질이 표기차(대소문자·공백)로 복수 id 로 쪼개져 규제가 분절된 경우를 보정 —
  // 형제 id(정규화 INCI/동일 CAS) 전부의 규제를 country 별로 합산. siblingIds 없으면 자기 1개.
  const ids = ds.siblingIds.get(ingredient.id) ?? [ingredient.id];
  const bucketFor = (code: string): Regulation[] | undefined => {
    let merged: Regulation[] | null = null;
    for (const id of ids) {
      const b = ds.regsByIngredientCountry.get(id)?.get(code);
      if (b && b.length) (merged ??= []).push(...b);
    }
    if (!merged) return undefined;
    // priority desc → last_verified desc (data-loader 버킷 정렬과 동일). 동일 출처 중복 제거.
    merged.sort((a, b) => {
      const pa = a.source_priority ?? 0, pb = b.source_priority ?? 0;
      if (pa !== pb) return pb - pa;
      return (b.last_verified_at ?? "").localeCompare(a.last_verified_at ?? "");
    });
    const seen = new Set<string>();
    return merged.filter((r) => {
      const k = `${r.source_document ?? ""}|${r.source_url ?? ""}|${r.status}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const results: CountryLookupResult[] = [];
  for (const code of targetCodes) {
    const country = ds.countryByCode.get(code);
    if (!country) continue;

    // bucket 은 priority desc → last_verified desc 로 정렬 — [0] 이 1차 우선.
    const bucket = bucketFor(code);
    let row = bucket?.[0];
    let allBucket = bucket;

    // 상속 fallback (예: VN inherits EU)
    let fromInherit: string | null = null;
    if (!row && country.inherits_from) {
      const inheritedBucket = bucketFor(country.inherits_from);
      row = inheritedBucket?.[0];
      if (row) {
        fromInherit = country.inherits_from;
        allBucket = inheritedBucket;
      }
    }

    const allSources: SourceRef[] | undefined = allBucket?.map((r) => ({
      source_document: r.source_document,
      source_url: r.source_url,
      source_priority: r.source_priority,
      status: r.status,
      max_concentration: r.max_concentration,
      concentration_unit: r.concentration_unit,
      conditions: r.conditions,
      last_verified_at: r.last_verified_at,
      confidence_score: r.confidence_score,
    }));

    // KCIA 보조 자료 — country별 최근 5건만 전달 (협회 회원 자료 link)
    const kciaArticles = ds.kciaByCountry.get(code)?.slice(0, 5);
    // 자동 다운로드된 1차 소스 PDF — 사용자가 원본 PDF 직접 다운 link
    const sourcePdfs = ds.sourcePdfsByCountry.get(code);

    if (row) {
      results.push({
        country_code: code,
        country_name_ko: country.name_ko,
        regulation_type: country.regulation_type,
        registry_url: country.registry_url ?? null,
        registry_name: country.registry_name ?? null,
        source: "verified",
        status: row.status as CountryLookupResult["status"],
        max_concentration: row.max_concentration,
        concentration_unit: row.concentration_unit,
        product_categories: row.product_categories ?? [],
        conditions: row.conditions,
        source_url: row.source_url,
        source_document: row.source_document,
        source_priority: row.source_priority,
        confidence_score: row.confidence_score,
        last_verified_at: row.last_verified_at,
        inherits_from: fromInherit,
        override_note: row.override_note,
        kcia_articles: kciaArticles,
        source_pdfs: sourcePdfs,
        all_sources: allSources,
      });
      continue;
    }

    // quarantine pending lookup — name_raw substring match against current ingredient
    const quarMap = ds.quarantineByCountryName.get(code);
    if (quarMap) {
      const lowerInci = ingredient.inci_name.toLowerCase();
      let pendingHit: { rejection_reason: string | null } | null = null;
      for (const [name, q] of quarMap) {
        if (lowerInci.includes(name) || name.includes(lowerInci)) {
          pendingHit = q;
          break;
        }
      }
      if (pendingHit) {
        results.push({
          country_code: code,
          country_name_ko: country.name_ko,
          regulation_type: country.regulation_type,
        registry_url: country.registry_url ?? null,
        registry_name: country.registry_name ?? null,
          source: "pending",
          pending_reason: pendingHit.rejection_reason ?? undefined,
          kcia_articles: kciaArticles,
          source_pdfs: sourcePdfs,
        });
        continue;
      }
    }

    results.push({
      country_code: code,
      country_name_ko: country.name_ko,
      regulation_type: country.regulation_type,
      source: "not_found",
      kcia_articles: kciaArticles,
      source_pdfs: sourcePdfs,
    });
  }

  return { query: q, ingredient, results };
}
