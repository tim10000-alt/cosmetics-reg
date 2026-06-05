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

// 예외(확인 필요) — 같은 한글명이나 표기/CAS 차이로 자동통합되지 않은 '동일 물질 추정' 레코드.
// 추측 병합(오병합 위험)도, 침묵 누락도 아닌 '투명 노출' — 연구원이 동일물질 여부를 직접 확인.
export interface RelatedVariant {
  inci_name: string;
  extra_country_names: string[];   // 이 표기 레코드에만 있는(현재 결과엔 없는) 국가 규제
}

export interface LookupResponse {
  query: string;
  ingredient: IngredientMatch | null;
  results: CountryLookupResult[];
  related_variants?: RelatedVariant[];
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

  // 4) substring 검색 — INCI / Korean / Chinese / Japanese.
  // F6: 첫 매치 반환은 의도와 다른 원료를 잡을 수 있어, 가장 근접한 후보를 랭킹 선택.
  // 점수 낮을수록 우선: 접두(startsWith) > 부분포함, 그리고 이름이 짧을수록(=질의에 근접) 우선.
  let best: Ingredient | null = null;
  let bestScore = Infinity;
  for (const ing of ds.ingredients) {
    const inci = ing.inci_name ? ing.inci_name.toLowerCase() : null;
    const kor = ing.korean_name ? ing.korean_name.toLowerCase() : null;
    let score = Infinity;
    if (inci && inci.includes(safe)) score = Math.min(score, (inci.startsWith(safe) ? 0 : 1000) + inci.length);
    if (kor && kor.includes(safe)) score = Math.min(score, (kor.startsWith(safe) ? 0 : 1000) + kor.length);
    if (ing.chinese_name && ing.chinese_name.includes(query)) score = Math.min(score, 500 + ing.chinese_name.length);
    if (ing.japanese_name && ing.japanese_name.includes(query)) score = Math.min(score, 500 + ing.japanese_name.length);
    // 5) synonym 매칭 — 통용명(예: "Bronopol")으로도 도달. 이름(INCI/한/중/일) 어디에도
    //    안 걸린 경우(score=Infinity)에만 발동 + 2000+ 로 항상 최하위 우선순위 → 기존 resolve
    //    결과는 절대 불변(순수 additive). 어떤 이름에도 매칭 안 되던 질의만 새로 도달.
    if (score === Infinity && ing.synonyms) {
      for (const syn of ing.synonyms) {
        const s = syn.toLowerCase();
        if (s.includes(safe)) { score = 2000 + (s.startsWith(safe) ? 0 : 1000) + s.length; break; }
      }
    }
    if (score < bestScore) { bestScore = score; best = ing; }
  }
  return best;
}

// 형제 그룹(이미 CAS/INCI 로 병합된 동일물질)의 *대표 표시명*을 한국 등록 표준명 우선으로 선택.
// 같은 물질이 영문 동의어(예: "Methylene Chloride")로 resolve 돼도 한국 등록명("Dichloromethane /
// 다이클로로메탄")을 대표로 보여주기 위함. 데이터를 새로 합치는 게 아니라 *이미 묶인 것 중 어느 이름을
// 보여줄지* 고르는 것이라 오융합 위험 0. 결정론·외부호출 0 → 무료 자동(매 조회 시 계산).
function buildCanonical(
  ids: string[],
  resolved: IngredientMatch,
  ds: Awaited<ReturnType<typeof dataset>>,
): IngredientMatch {
  const members = ids.map((id) => ds.ingredientById.get(id)).filter(Boolean) as IngredientMatch[];
  if (members.length <= 1) return resolved;
  // 대표 점수: 한국등록(korean_name) > 정상케이스(외국 ALL-CAPS 후순위) > 군더더기 없음 > CAS 보유, 짧을수록 가산.
  const score = (m: IngredientMatch): number => {
    const inci = m.inci_name || "";
    const isAllCaps = inci === inci.toUpperCase() && /[A-Z]/.test(inci);
    const hasJunk = /,?\s*C(?:AS|I)\s*[\d\-]/i.test(inci) || /\[\d\]/.test(inci) || /[,;]/.test(inci);
    return (m.korean_name ? 1000 : 0) + (isAllCaps ? 0 : 100) + (hasJunk ? 0 : 50) + (m.cas_no ? 10 : 0) - inci.length * 0.01;
  };
  const rep = [...members].sort((a, b) => score(b) - score(a))[0];
  const firstOf = (f: keyof IngredientMatch): string | null => {
    if (rep[f]) return rep[f] as string;
    for (const m of members) if (m[f]) return m[f] as string;
    return null;
  };
  // CAS union (유효 형식만, 중복 제거)
  const casSet: string[] = [];
  for (const m of members) for (const c of String(m.cas_no || "").split(/[\s,;]+/)) {
    const t = c.trim(); if (/^\d{2,7}-\d{2}-\d$/.test(t) && !casSet.includes(t)) casSet.push(t);
  }
  // synonyms union + 형제들의 다른 표기(inci)도 동의어로 노출(검색·"왜 이게 떴나" 투명성)
  const synSet: string[] = [];
  const repInciLc = (rep.inci_name || "").toLowerCase(), repKorLc = (rep.korean_name || "").toLowerCase();
  const addSyn = (s: string | null | undefined) => {
    const v = (s || "").trim(); if (!v) return;
    if (v.toLowerCase() === repInciLc || v.toLowerCase() === repKorLc) return;
    if (!synSet.some((x) => x.toLowerCase() === v.toLowerCase())) synSet.push(v);
  };
  for (const m of members) { (m.synonyms || []).forEach(addSyn); if (m.id !== rep.id) addSyn(m.inci_name); }
  return {
    id: rep.id,
    inci_name: rep.inci_name,
    korean_name: firstOf("korean_name"),
    chinese_name: firstOf("chinese_name"),
    japanese_name: firstOf("japanese_name"),
    cas_no: casSet.length ? casSet.join(", ") : null,
    synonyms: synSet,
    description: firstOf("description"),
    function_category: firstOf("function_category"),
    function_description: firstOf("function_description"),
  };
}

export async function lookupRegulation(
  query: string,
  countries?: string[],
): Promise<LookupResponse> {
  const ds = await dataset();
  const q = query.trim();
  if (!q) return { query: q, ingredient: null, results: [] };

  const resolved = findIngredientSync(q, ds);
  if (!resolved) return { query: q, ingredient: null, results: [] };

  const targetCodes = countries && countries.length > 0
    ? countries
    : ds.countries.map((c) => c.code);

  // F5: 같은 물질이 표기차(대소문자·공백)로 복수 id 로 쪼개져 규제가 분절된 경우를 보정 —
  // 형제 id(정규화 INCI/동일 CAS) 전부의 규제를 country 별로 합산. siblingIds 없으면 자기 1개.
  const ids = ds.siblingIds.get(resolved.id) ?? [resolved.id];
  // 표시 성분 = 형제 그룹의 한국 등록 표준명 대표(영문 동의어로 resolve 돼도 한국명으로 표기).
  const ingredient = buildCanonical(ids, resolved, ds);
  const bucketFor = (code: string): Regulation[] | undefined => {
    let merged: Regulation[] | null = null;
    for (const id of ids) {
      const b = ds.regsByIngredientCountry.get(id)?.get(code);
      if (b && b.length) (merged ??= []).push(...b);
    }
    if (!merged) return undefined;
    // 정보충실도 desc → priority desc → last_verified desc. 동일 출처 중복 제거.
    // (정품검증: 농도·조건이 비어있는 '신원만' 공식행(EU-EURLex 등 자동파싱)이 실제
    //  한도·조건을 담은 큐레이션행(MFDS)을 priority 로 가려 1차에 빈값이 뜨던 버그 수정.)
    // ① 기존대로 priority 로 '대표 status' 결정 — status 선택은 바꾸지 않음(over-merge 로
    //    인한 잘못된 격상/격하 위험 회피, 별도 데이터 감사 영역).
    const byPriority = (a: Regulation, b: Regulation) => {
      const pa = a.source_priority ?? 0, pb = b.source_priority ?? 0;
      if (pa !== pb) return pb - pa;
      return (b.last_verified_at ?? "").localeCompare(a.last_verified_at ?? "");
    };
    const winStatus = [...merged].sort(byPriority)[0].status;
    // ② 그 status 행들 중 '정보충실(농도·실조건 보유)' 행을 1차로 — 빈 '신원만' 자동파싱
    //    행이 농도·조건 담긴 큐레이션 행을 가리던 버그 수정. status 는 불변.
    const detailScore = (r: Regulation): number => {
      const c = r.conditions ?? "";
      const identityOnly = c.length < 20 || /등재 \(Reference \d+\)/.test(c);
      const hasDetail = !identityOnly && c.length >= 60;
      return (r.max_concentration != null ? 2 : 0) + (hasDetail ? 1 : 0);
    };
    merged.sort((a, b) => {
      const aw = a.status === winStatus ? 1 : 0, bw = b.status === winStatus ? 1 : 0;
      if (aw !== bw) return bw - aw;
      const da = detailScore(a), db = detailScore(b);
      if (da !== db) return db - da;
      return byPriority(a, b);
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

  // 예외(확인 필요) 관련 표기 — 같은 한글명이나 표기/CAS 차이로 자동통합 안 된 동일추정 레코드 중,
  // 현재 결과에 없는 국가 규제를 가진 것만. 거대 한글 그룹(석유류 카테고리 등)은 변이가 아니므로 제외.
  const related_variants: RelatedVariant[] = [];
  if (ingredient.korean_name) {
    const sameKorean = ds.idsByKoreanLower.get(ingredient.korean_name.toLowerCase()) ?? [];
    if (sameKorean.length > 1 && sameKorean.length <= 20) {
      const sibSet = new Set(ids);
      const coveredVerified = new Set(
        results.filter((r) => r.source === "verified").map((r) => r.country_code),
      );
      for (const oid of sameKorean) {
        if (sibSet.has(oid) || oid === ingredient.id) continue;
        const other = ds.ingredientById.get(oid);
        const otherRegs = ds.regsByIngredientCountry.get(oid);
        if (!other || !otherRegs) continue;
        const extra = Array.from(otherRegs.keys()).filter((cc) => !coveredVerified.has(cc));
        if (extra.length > 0) {
          related_variants.push({
            inci_name: other.inci_name,
            extra_country_names: extra.map((cc) => ds.countryByCode.get(cc)?.name_ko ?? cc),
          });
        }
      }
    }
  }

  return {
    query: q,
    ingredient,
    results,
    related_variants: related_variants.length ? related_variants : undefined,
  };
}
