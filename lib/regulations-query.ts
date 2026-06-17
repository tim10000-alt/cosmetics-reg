import { dataset, type Ingredient, type Regulation, type KciaArticle, type SourcePdf } from "./data-loader";
import { translateDisplay } from "./translate-display";
import { koreanizeName } from "./jp-name-koreanize";

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
  product_categories?: string[];   // 용도/제품군 — 용도별 규제를 개별 표기하기 위해 출처별 보존
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
  // 출처 상충: 대표 status(헤드라인)보다 더 엄격한 status(금지>제한>허용)를 주장하는 출처가 존재.
  // 자동으로 status 를 바꾸지 않는다 — MFDS '사용제한' 데이터의 banned/restricted 오분류와 과거 한도
  // 잔존(예: 금지된 파라벤에 옛 0.4% 한도) 때문에 어느 방향으로 자동결정해도 오표기 위험. 대신 상충을
  // 표면화해 전문가(연구원)가 원문 대조로 판단하게 한다(분별력). null = 상충 없음.
  status_conflict?: { statuses: string[]; sources: { status: string; source_document: string | null }[] } | null;
  // EU 채택국(ASEAN ACD / Andean 833)에서 자국 한도가 없을 때, 채택 원천 EU 의 한도(법적으로 동일).
  // 결정론·무AI·source-grounded — 앱이 준비된 EU 데이터를 끌어와 채움(검색마다 AI 호출 아님).
  adopted_limit?: { max_concentration: number | null; concentration_unit: string | null; conditions: string | null; from: string } | null;
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
  kcia_code?: string | null;
  // 표시 전용 한글화 제목(inci_name 이 일본어/중국어일 때). 검색·클릭은 inci_name(원본) 유지.
  inci_display?: string;
}

// 예외(확인 필요) — 같은 한글명이나 표기/CAS 차이로 자동통합되지 않은 '동일 물질 추정' 레코드.
// 추측 병합(오병합 위험)도, 침묵 누락도 아닌 '투명 노출' — 연구원이 동일물질 여부를 직접 확인.
export interface RelatedVariant {
  inci_name: string;
  extra_country_names: string[];   // 이 표기 레코드에만 있는(현재 결과엔 없는) 국가 규제
  inci_display?: string;           // 일/중 표기 한글화(검색은 inci_name 원본 유지)
}

export interface LookupResponse {
  query: string;
  ingredient: IngredientMatch | null;
  results: CountryLookupResult[];
  related_variants?: RelatedVariant[];
  // 같은 질의에 매칭된 *다른* 원료(형제그룹) — 단일 best 가 가리던 결과를 선택지로 노출(shadowing 제거).
  other_matches?: IngredientMatch[];
}

function sanitize(s: string): string {
  return s.replace(/[,()%_\\"]/g, " ").replace(/\s+/g, " ").trim();
}

// 질의에 대한 *모든* 매칭을 점수순(낮을수록 우선)으로 반환 — 단일 best 만 쓰면 같은 질의에
// 매칭되는 다른 원료가 가려짐(shadowing). lookupRegulation 이 [0]=주결과, 나머지=other_matches(선택지).
function rankIngredients(
  query: string,
  ds: Awaited<ReturnType<typeof dataset>>,
  limit: number,
): Ingredient[] {
  const safe = sanitize(query).toLowerCase();
  if (!safe) return [];
  // CAS 정확 매칭 — 명확(단일).
  if (/^\d{1,7}-\d{2}-\d$/.test(query.trim())) {
    const cas = ds.ingredientByCas.get(query.trim());
    if (cas) return [cas];
  }
  const scored: { ing: Ingredient; score: number }[] = [];
  for (const ing of ds.ingredients) {
    // 질의(safe)와 동일 정규화(쉼표/괄호→공백·공백압축) 한 이름으로 비교 — 비대칭으로 인해
    // 전체명("Borates (Sodium borate, tetraborate)" 등 쉼표/괄호 포함)이 검색 미도달이던 버그 수정.
    const inci = ing.inci_name ? sanitize(ing.inci_name.toLowerCase()) : null;
    // 한글명 또는 한글화 별칭(koreanized) — 화면에 보이는 한글로 검색해도 도달(findability).
    const kor = (ing.korean_name || ing.koreanized) ? sanitize((ing.korean_name || ing.koreanized)!.toLowerCase()) : null;
    let score = Infinity;
    if (inci && inci.includes(safe)) score = Math.min(score, (inci === safe ? 0 : inci.startsWith(safe) ? 1 : 1000) + inci.length);
    if (kor && kor.includes(safe)) score = Math.min(score, (kor === safe ? 0 : kor.startsWith(safe) ? 1 : 1000) + kor.length);
    if (ing.chinese_name && ing.chinese_name.includes(query)) score = Math.min(score, 500 + ing.chinese_name.length);
    if (ing.japanese_name && ing.japanese_name.includes(query)) score = Math.min(score, 500 + ing.japanese_name.length);
    // synonym 매칭 — 통용명(예: "Bronopol")으로도 도달. 이름 어디에도 안 걸린 경우에만 발동
    // + 2000+ 로 최하위 → 기존 resolve 결과 불변(순수 additive).
    if (score === Infinity && ing.synonyms) {
      for (const syn of ing.synonyms) {
        const s = syn.toLowerCase();
        if (s.includes(safe)) { score = 2000 + (s.startsWith(safe) ? 1 : 1000) + s.length; break; }
      }
    }
    if (score < Infinity) scored.push({ ing, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((x) => x.ing);
}

// 파서 누출 아티팩트 판별 — 규제 표(EU AnnexII/III 등)의 컬럼이 이름/동의어 필드에 통째로
// 접합된 경우(개행·CAS/EC번호·한도% glue). 표시명/동의어 후보에서 이런 잔재를 후순위·제외하는 데 사용.
// 정상 화학명/약어는 개행·CAS·EC번호·한도%를 포함하지 않으므로 false. (legit 예외 극소수[%포함 용액명]는
// 동의어 칩에서만 빠지고 정체성·검색엔 무영향 → 분별력상 net 이득)
function isLeakArtifact(s: string): boolean {
  if (!s) return false;
  if (/[\r\n]/.test(s)) return true;                       // 멀티라인 = 표 행 wrap
  if (/\b\d{2,7}-\d{2}-\d\b/.test(s)) return true;         // 임베디드 CAS
  if (/\b\d{3}-\d{3}-\d\b/.test(s)) return true;           // 임베디드 EC 번호
  if (/\d[.,]\d+\s*%/.test(s) || /\s\d{1,3}\s*%/.test(s)) return true;  // 임베디드 한도%
  return false;
}

// 표시명 위생 — 규제표(EU AnnexII/III 등)의 컬럼이 이름에 통째로 접합된 잔재를 *표시 시점*에만 제거.
// 데이터(저장 inci_name)는 불변 → 검색 인덱스·canonName 형제그룹·정체성 무영향. 결정론·가역.
// 제거 대상은 *명확한 경계*가 있는 것만: 개행/탭/중복공백 collapse, " / <CAS> / <EC> <각주>" 컬럼,
// "and a mixture of if they contain >N% X" boilerplate. 화학명 본체·scope("and its salts" 등)는 보존.
function cleanDisplayName(raw: string | null | undefined): string {
  const r = (raw || "").toString();
  if (!r) return r;
  let s = r.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  s = s.replace(/\s*\/\s*\d{2,7}-\d{2}-\d.*$/, "").trim();   // "/ CAS / EC / footnote" 컬럼 누출
  s = s.replace(/\s*[（(]\s*CAS\s*N[oO]\.?\s*\d{2,7}-\d{2}-\d\s*[）)]/gi, "").trim();  // "(CAS No. 65-85-0)" 주석 누출(CAS 는 카드 CAS 필드에 별도 표시 → 이름 내 중복 제거). 명확경계: "CAS No"+유효CAS+괄호
  s = s.replace(/\s+and a mixture of\b.*$/i, "").trim();     // "and a mixture of if they contain >N% X"
  s = s.replace(/[,;]?\s+if (?:they|it) contains?\b.*$/i, "").trim();  // EU 조건어 "X if they contain >N% Y"(화학명엔 없음)
  s = s.replace(/[,;]?\s+except for\b.*$/i, "").trim();      // EU 조건어 "X except for normal content..."(화학명엔 없음)
  s = s.replace(/,(\s*,)+/g, ",").replace(/^\s*,\s*|\s*,\s*$/g, "").replace(/\s{2,}/g, " ").trim();  // 빈/연속/엣지 콤마(파서 토큰누락 "X, , Y") 정리
  return s || r;
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
  // 표시명 위생을 *모든* name 필드에 균일 적용(영문/한글/중국어/일본어). cleanDisplayName 의 strip 규칙은
  // 영문 키워드(if they contain·CAS No·and a mixture 등) 기준이라 한글/중국어 규제문("부타디엔 0.1%를
  // 초과하여 함유하는…")엔 매칭 안 됨 → 정당한 규제 entry명은 보존하고, 개행/탭 wrap·"(CAS No. X)" 주석만
  // 정리(실측: korean 21건 newline/주석, chinese/japanese 0). 장기 전자동: 파이프라인이 어떤 필드에 누출을
  // 만들어도 표시 시점에 균일 정리(누락 0). null 은 보존.
  const cleanNm = (v: string | null): string | null => (v == null ? v : cleanDisplayName(v));
  // 중/일 *언어 참조* 필드가 코드(CI 색인번호·CAS·EC번호)뿐이면 = 실제 중/일명 아님 → 표시 null
  //   (육안 발견: 색소가 chinese_name="CI 77491"·japanese_name="CI 77015"로 오표시. CJK검사 사각=코드엔
  //   한자 없음). firstRealName 은 형제 중 *진짜 이름*(코드 아님)을 우선 선택, 없으면 null.
  const isBareCode = (v: string): boolean => /^(C\.?\s*I\.?\s*\d{3,6}|\d{2,7}-\d{2}-\d|EC\s*\d[\d\s-]*|\d{3}-\d{3}-\d)$/i.test(v.trim());
  const langNm = (v: string | null): string | null => { const c = cleanNm(v); return c && isBareCode(c) ? null : c; };
  // inci_name 이 일본어/중국어면 표시용 한글 제목(inci_display)을 채우고, 원본 CJK는 japanese_name
  // 으로 보존(라벨된 참조). 검색·클릭은 inci_name(원본) 유지 → 검색 인덱스 무영향.
  const CJK_NAME = /[぀-ヿ㐀-鿿豈-﫿]/;
  // 로마자-일본어 추출물명("RYOKU-CHA EKISU"=ウーロン茶エキス 류) → 학명+추출물. 영어 INCI 도 한글도
  //   아닌 *로마자 일본어*가 제목 노출(육안 발견). koreanize 는 CJK 만 잡아 로마자는 통과 → 별도 처리.
  //   chinese_name 의 라틴 학명("…（CAMELLIA SINENSIS）提取物")을 INCI 앵커로(보편 식별자).
  const romajiJpDisplay = (m: IngredientMatch): string | null => {
    if (CJK_NAME.test(m.inci_name)) return null;
    const ek = /EKISU/i.test(m.inci_name), yu = /(^|[ -])YU($|[ -])/i.test(m.inci_name);  // エキス=추출물, 油=오일
    if (!ek && !yu) return null;
    const bino = (m.chinese_name || "").match(/([A-Z]{2,}(?:\s+[A-Z][A-Za-z.\-]+)+)/);
    if (bino) {
      const tc = bino[1].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
      if (tc.length >= 4) return tc + (ek ? " 추출물" : " 오일");
    }
    // 학명 없으면 korean_name 으로 제목(로마자 일본어 제목 회피 — 한글명 존재 시).
    return m.korean_name && /[가-힣]/.test(m.korean_name) ? m.korean_name : null;
  };
  const koDisplay = (m: IngredientMatch): IngredientMatch => {
    const rj = romajiJpDisplay(m);
    if (rj) return { ...m, inci_display: rj };
    if (!CJK_NAME.test(m.inci_name)) return m;
    const kn = koreanizeName(m.inci_name);
    if (kn.name === m.inci_name) return m;
    const HAS_KANA = /[ぁ-ヾ]/;
    // 원문 보존은 *가나가 든 진짜 일본어명*에만(중문/라틴 한약재를 "일본어"로 오라벨 방지).
    const ja = m.japanese_name || (HAS_KANA.test(m.inci_name) ? m.inci_name : m.japanese_name);
    return { ...m, inci_display: kn.name, japanese_name: ja };
  };
  if (members.length <= 1) {
    // 형제 없는 단일 레코드도 표시명 위생 + 누출 동의어 제거(standalone 코럽트 헤드라인 대응).
    const cleaned = cleanDisplayName(resolved.inci_name);
    const ko = langNm(resolved.korean_name), zh = langNm(resolved.chinese_name), ja = langNm(resolved.japanese_name);
    const syn = (resolved.synonyms || []).filter((x) => { const t = (x || "").trim(); return t.length > 1 && !/^[\d.\-()[\]{}]+$/.test(t) && !isLeakArtifact(x); });  // 단일레코드도 무의미 단편(단일문자·순숫자) 제거
    // cas_no 제어문자(\r\n\t) 위생 — 저장값 오염(예 "328-39-2(DL-)\r,61-90-5(L-)")이 표시에 새지 않게.
    const casClean = resolved.cas_no ? resolved.cas_no.replace(/[\r\n\t]+/g, " ").replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim() : resolved.cas_no;
    const base = cleaned === resolved.inci_name && ko === resolved.korean_name && zh === resolved.chinese_name && ja === resolved.japanese_name && syn.length === (resolved.synonyms || []).length && casClean === resolved.cas_no
      ? resolved : { ...resolved, inci_name: cleaned, korean_name: ko, chinese_name: zh, japanese_name: ja, synonyms: syn, cas_no: casClean };
    return koDisplay(base);
  }
  // 대표 점수: 한국등록(korean_name) > 정상케이스(외국 ALL-CAPS 후순위) > 군더더기 없음 > CAS 보유, 짧을수록 가산.
  const score = (m: IngredientMatch): number => {
    const inci = m.inci_name || "";
    const isAllCaps = inci === inci.toUpperCase() && /[A-Z]/.test(inci);
    const hasJunk = /,?\s*C(?:AS|I)\s*[\d\-]/i.test(inci) || /\[\d\]/.test(inci) || /[,;]/.test(inci) || isLeakArtifact(inci);
    return (m.kcia_code ? 2000 : 0) + (m.korean_name ? 1000 : 0) + (isAllCaps ? 0 : 100) + (hasJunk ? 0 : 50) + (m.cas_no ? 10 : 0) - inci.length * 0.01;
  };
  const rep = [...members].sort((a, b) => score(b) - score(a))[0];
  const repInci = cleanDisplayName(rep.inci_name);   // 표시 위생(공백·규제표 컬럼 누출 제거)
  const firstOf = (f: keyof IngredientMatch): string | null => {
    if (rep[f]) return rep[f] as string;
    for (const m of members) if (m[f]) return m[f] as string;
    return null;
  };
  // 중/일명: 형제 중 코드(CI번호 등)가 아닌 *진짜 이름* 우선. 전부 코드뿐이면 null.
  const firstRealName = (f: "chinese_name" | "japanese_name" | "korean_name"): string | null => {
    const cands = [rep[f], ...members.map((m) => m[f])].filter(Boolean) as string[];
    const real = cands.find((v) => !isBareCode(cleanDisplayName(v)));
    return real ?? null;
  };
  // CAS union (유효 형식만, 중복 제거)
  const casSet: string[] = [];
  for (const m of members) for (const c of String(m.cas_no || "").split(/[\s,;]+/)) {
    const t = c.trim(); if (/^\d{2,7}-\d{2}-\d$/.test(t) && !casSet.includes(t)) casSet.push(t);
  }
  // synonyms union + 형제들의 다른 표기(inci)도 동의어로 노출(검색·"왜 이게 떴나" 투명성)
  const synSet: string[] = [];
  const repInciLc = repInci.toLowerCase(), repKorLc = (rep.korean_name || "").trim().toLowerCase();
  const addSyn = (s: string | null | undefined) => {
    let v = (s || "").trim(); if (!v) return;
    if (CJK_NAME.test(v)) v = koreanizeName(v).name;  // 일/중 형제 표기 동의어 칩도 한글화(다른언어 불가)
    // 무의미 단편 제거 — 단일문자("잎"·"꽃"·"N") 또는 순숫자/기호("0"). 긴 이름에서 잘린 잔재(육안 발견).
    if (v.length <= 1 || /^[\d.\-()[\]{}]+$/.test(v)) return;
    if (v.toLowerCase() === repInciLc || v.toLowerCase() === repKorLc) return;
    if (isLeakArtifact(v)) return;  // 파서 누출(개행·CAS/EC번호·한도% glue)을 동의어 칩으로 노출 금지
    if (!synSet.some((x) => x.toLowerCase() === v.toLowerCase())) synSet.push(v);
  };
  for (const m of members) { (m.synonyms || []).forEach(addSyn); if (m.id !== rep.id) addSyn(m.inci_name); }
  return koDisplay({
    id: rep.id,
    inci_name: repInci,
    korean_name: langNm(firstRealName("korean_name")),
    chinese_name: langNm(firstRealName("chinese_name")),
    japanese_name: langNm(firstRealName("japanese_name")),
    cas_no: casSet.length ? casSet.join(", ") : null,
    synonyms: synSet,
    description: firstOf("description"),
    function_category: firstOf("function_category"),
    function_description: firstOf("function_description"),
    kcia_code: firstOf("kcia_code"),
  });
}

export async function lookupRegulation(
  query: string,
  countries?: string[],
): Promise<LookupResponse> {
  const ds = await dataset();
  const q = query.trim();
  if (!q) return { query: q, ingredient: null, results: [] };

  // 단일 스캔 — 상위 매칭 목록을 한 번에 구해 [0]=주결과, 나머지=other_matches(이중 O(N) 스캔 제거).
  const ranked = rankIngredients(q, ds, 60);
  const resolved = ranked[0];
  if (!resolved) return { query: q, ingredient: null, results: [] };

  const targetCodes = countries && countries.length > 0
    ? countries
    : ds.countries.map((c) => c.code);

  // F5: 같은 물질이 표기차(대소문자·공백)로 복수 id 로 쪼개져 규제가 분절된 경우를 보정 —
  // 형제 id(정규화 INCI/동일 CAS) 전부의 규제를 country 별로 합산. siblingIds 없으면 자기 1개.
  const ids = ds.siblingIds.get(resolved.id) ?? [resolved.id];
  // 표시 성분 = 형제 그룹의 한국 등록 표준명 대표(영문 동의어로 resolve 돼도 한국명으로 표기).
  const ingredient = buildCanonical(ids, resolved, ds);

  // 다중결과 — 같은 질의에 매칭된 *다른 형제그룹* 들을 선택지로(shadowing 제거). 형제그룹 키로
  // 중복 제거(같은 물질의 표기변형은 1개로), 주결과 그룹은 제외. 최대 8개.
  const groupKey = (i: Ingredient): string => {
    const sib = ds.siblingIds.get(i.id);
    return sib && sib.length ? [...sib].sort()[0] : i.id;
  };
  const seenGroups = new Set<string>([groupKey(resolved)]);
  const otherMatches: IngredientMatch[] = [];
  for (const cand of ranked) {
    const gk = groupKey(cand);
    if (seenGroups.has(gk)) continue;
    seenGroups.add(gk);
    const cIds = ds.siblingIds.get(cand.id) ?? [cand.id];
    otherMatches.push(buildCanonical(cIds, cand, ds));
    if (otherMatches.length >= 8) break;
  }
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
    // ① priority 로 '대표 status' 결정. **동일 priority 동률 시 severity(banned>restricted>listed)
    //    우선** — 같은 권위가 금지/허용을 동시 보유할 때(예: 중국 NMPA 표1 금지 vs IECIC 已使用목록
    //    등재, ASEAN Annex II 금지 vs Annex IV 색소허용) 더 엄격한 banned 를 헤드라인으로(분별력:
    //    진짜 금지물질이 last_verified 우연으로 '허용' 표기되는 false-allowed=규제사고 방지). 허용은
    //    status_conflict 배지로 표면화. (조건부금지는 데이터 단계서 restricted 로 교정 → 여기선 절대금지만 banned.)
    const sevRank = (s: Regulation["status"]): number =>
      s === "banned" ? 3 : s === "restricted" ? 2 : (s === "allowed" || s === "listed") ? 1 : 0;
    const byPriority = (a: Regulation, b: Regulation) => {
      const pa = a.source_priority ?? 0, pb = b.source_priority ?? 0;
      if (pa !== pb) return pb - pa;
      const sa = sevRank(a.status), sb = sevRank(b.status);
      if (sa !== sb) return sb - sa;
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
      source_document: translateDisplay(r.source_document, ds.translations),
      source_url: r.source_url,
      source_priority: r.source_priority,
      status: r.status,
      max_concentration: r.max_concentration,
      concentration_unit: r.concentration_unit,
      product_categories: r.product_categories ?? undefined,   // 용도별 개별 표기용
      conditions: translateDisplay(r.conditions, ds.translations),
      last_verified_at: r.last_verified_at,
      confidence_score: r.confidence_score,
    }));

    // 출처 상충 감지 — 헤드라인 status 보다 더 엄격한 status 를 가진 출처가 있으면 표면화.
    // 심각도: 금지(3) > 제한(2) > 허용/listed(1) > 미등재/unknown(0). status 자체는 바꾸지 않는다.
    const sev = (s: string | null | undefined): number =>
      s === "banned" ? 3 : s === "restricted" ? 2 : (s === "allowed" || s === "listed") ? 1 : 0;
    let statusConflict: CountryLookupResult["status_conflict"] = null;
    if (row && allBucket && allBucket.length > 1) {
      const headSev = sev(row.status);
      const stricter = allBucket.filter((r) => sev(r.status) > headSev);
      if (stricter.length) {
        const byStatus = new Map<string, string | null>();
        for (const r of stricter) if (r.status && !byStatus.has(r.status)) byStatus.set(r.status, translateDisplay(r.source_document, ds.translations));
        statusConflict = {
          statuses: [...byStatus.keys()],
          sources: [...byStatus.entries()].map(([status, source_document]) => ({ status, source_document })),
        };
      }
    }

    // KCIA 보조 자료 — country별 최근 5건만 전달 (협회 회원 자료 link)
    const kciaArticles = ds.kciaByCountry.get(code)?.slice(0, 5);
    // 자동 다운로드된 1차 소스 PDF — 사용자가 원본 PDF 직접 다운 link. 제목(原 정부문서명)도 한글화.
    const sourcePdfsRaw = ds.sourcePdfsByCountry.get(code);
    const sourcePdfs = sourcePdfsRaw?.map((p) => ({ ...p, title: translateDisplay(p.title, ds.translations) }));

    if (row) {
      results.push({
        country_code: code,
        country_name_ko: country.name_ko,
        regulation_type: country.regulation_type,
        registry_url: country.registry_url ?? null,
        registry_name: translateDisplay(country.registry_name ?? null, ds.translations),
        source: "verified",
        status: row.status as CountryLookupResult["status"],
        max_concentration: row.max_concentration,
        concentration_unit: row.concentration_unit,
        product_categories: row.product_categories ?? [],
        conditions: translateDisplay(row.conditions, ds.translations),
        source_url: row.source_url,
        source_document: translateDisplay(row.source_document, ds.translations),
        source_priority: row.source_priority,
        confidence_score: row.confidence_score,
        last_verified_at: row.last_verified_at,
        inherits_from: fromInherit,
        override_note: row.override_note,
        kcia_articles: kciaArticles,
        source_pdfs: sourcePdfs,
        all_sources: allSources,
        status_conflict: statusConflict,
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
        registry_name: translateDisplay(country.registry_name ?? null, ds.translations),
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

  // EU 채택국(ASEAN ACD / Andean Decisión 833 = EU annex 채택) 한도 보강(결정론·무AI):
  // 자국(verified) 행에 한도(숫자 or 조건문%)가 없으면, 채택 원천 EU 의 한도를 그대로 표시.
  // EU annex 를 법적으로 채택하므로 EU 한도가 곧 그 나라의 적용 한도. 이미 파싱된 EU 데이터를
  // 끌어와 채우는 것(검색마다 AI 호출 X — 설계 의도 부합). UI 에 "EU 채택 기준"으로 출처 명시.
  const hasLimit = (r: CountryLookupResult): boolean =>
    typeof r.max_concentration === "number" ||
    (!!r.conditions && /최대\s*농도|배합\s*한도|\d+(\.\d+)?\s*%|\d+,\d+\s*%/.test(r.conditions));
  const euRes = results.find((r) => r.country_code === "EU" && r.source === "verified");
  if (euRes && hasLimit(euRes)) {
    for (const r of results) {
      if (r.source !== "verified") continue;
      if (ds.countryByCode.get(r.country_code)?.inherits_from !== "EU") continue;
      if (hasLimit(r)) continue;
      r.adopted_limit = { max_concentration: euRes.max_concentration ?? null, concentration_unit: euRes.concentration_unit ?? null, conditions: euRes.conditions ?? null, from: "EU" };
    }
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
            inci_display: /[぀-ヿ㐀-鿿豈-﫿]/.test(other.inci_name) ? koreanizeName(other.inci_name).name : undefined,
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
    other_matches: otherMatches.length ? otherMatches : undefined,
  };
}
