// 클라이언트 측 정적 데이터 로더.
// public/data/*.json 을 한 번 fetch → 인메모리 인덱스. ETag/Last-Modified 는
// 브라우저가 자동 처리 — 데이터 파일이 변경되지 않으면 304 Not Modified 로 다운로드 0.
//
// 페이지 로드 시점에 즉시 prefetch 시작 (모듈 평가 시). 검색·자동완성은 await dataset()
// 으로 준비를 보장.

export interface Ingredient {
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
  kcia_code?: string | null;   // KCIA 표준화명칭 코드 = 권위 동일성 키(같은 코드=같은 성분)
}

export interface Regulation {
  ingredient_id: string;
  country_code: string;
  status: string;
  max_concentration: number | null;
  concentration_unit: string | null;
  product_categories: string[];
  conditions: string | null;
  source_url: string | null;
  source_document: string | null;
  source_priority: number | null;   // 100 = 자국 1차, 50 = 타국 정리, 30 = AI 파싱
  confidence_score: number | null;
  last_verified_at: string;
  override_note: string | null;
}

export interface Country {
  code: string;
  name_ko: string;
  inherits_from: string | null;
  regulation_type: "negative_list" | "positive_list" | "hybrid";
  registry_url?: string | null;   // positive_list/hybrid: 등록 원료 검색 가능 공식 사이트
  registry_name?: string | null;
}

export interface QuarantineRow {
  ingredient_name_raw: string;
  country_code: string;
  rejection_reason: string | null;
}

export interface Meta {
  generated_at: string;
  counts: {
    countries: number;
    ingredients: number;
    regulations: number;
    quarantine_pending: number;
  };
}

export interface SourcePdf {
  key: string;
  title: string;
  url: string;
  country: string;
  lang: string;
  file_path: string;
  size_bytes: number;
  downloaded_at: string;
  content_hash: string;
}

export interface KciaArticle {
  no: string;
  title: string;
  category: string;
  country_inferred: string | null;
  date: string;
  views: number;
  attach_pdf: boolean;
  attach_hwp: boolean;
  attach_excel: boolean;
  detail_url: string;
  body_excerpt?: string | null;
}

export interface Dataset {
  meta: Meta;
  ingredients: Ingredient[];
  // Lookup indices
  ingredientById: Map<string, Ingredient>;
  ingredientByInciLower: Map<string, Ingredient>;
  ingredientByKoreanLower: Map<string, Ingredient>;
  ingredientByCas: Map<string, Ingredient>;
  // 같은 한글명을 가진 모든 ingredient id (예외/관련표기 노출용 — 표기차로 자동통합 안 된 동일추정 레코드 탐지).
  idsByKoreanLower: Map<string, string[]>;
  // Regulation index: ingredient_id → country_code → row[] (source 우선순위로 정렬됨)
  regsByIngredientCountry: Map<string, Map<string, Regulation[]>>;
  // 같은 물질의 중복 ingredient id 묶음 (정규화 INCI 또는 동일 CAS). 1개 초과일 때만 등재.
  // F5: ingest 가 표기차(대소문자·공백)로 같은 원료를 복수 id 로 만들어 규제가 분절되는 것을
  // 쿼리 시점에 합산해 보정. id → 형제 id[] (자신 포함).
  siblingIds: Map<string, string[]>;
  countries: Country[];
  countryByCode: Map<string, Country>;
  // Quarantine: country_code → name_lower → row
  quarantineByCountryName: Map<string, Map<string, QuarantineRow>>;
  // KCIA articles: country_code → article[] (보조 정보)
  kciaByCountry: Map<string, KciaArticle[]>;
  // 1차 소스 PDF (자동 다운로드 — link 만 사용자에 노출)
  sourcePdfsByCountry: Map<string, SourcePdf[]>;
  // 표시 텍스트 번역 캐시(translations.json) — strKey(원문) → 한국어. 출처명·조건문의 외국어를
  // 표시 시점에 한글로 치환(데이터 불변). Gemini 파이프라인이 장기 누적, 결정론 seed 가 즉시 보강.
  translations: Map<string, string>;
}

let cached: Promise<Dataset> | null = null;

import { asset } from "./base-path";

async function fetchJson<T>(path: string): Promise<T> {
  // 하위경로 배포(GitHub Pages) 대응: 절대경로에 base path prefix. 로컬은 무변경.
  const res = await fetch(asset(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function loadDataset(): Promise<Dataset> {
  // regulations 는 country 별 분할 — countries.json 먼저 받고 나서 각 cc 의 regulations 병렬 fetch.
  const [metaPayload, ingPayload, ctyPayload, quarPayload, kciaPayload, srcPdfPayload] = await Promise.all([
    fetchJson<Meta>("/data/meta.json"),
    fetchJson<{ rows: Ingredient[] }>("/data/ingredients.json"),
    fetchJson<{ rows: Country[] }>("/data/countries.json"),
    fetchJson<{ rows: QuarantineRow[] }>("/data/quarantine.json"),
    fetchJson<{ rows: KciaArticle[] }>("/data/kcia-articles.json").catch(() => ({ rows: [] })),
    fetchJson<{ rows: SourcePdf[] }>("/data/sources-pdf.json").catch(() => ({ rows: [] })),
  ]);

  // 품질 가디언이 격리한 복구불가 오염 성분명(PDF matrix 잔해·각주행 등) — 검색/표시에서 제외.
  // (없으면 무시.) 이름이 깨진 비실성분이 검색결과를 오염시키지 않게.
  const quarantinedIds = new Set<string>(
    (await fetchJson<{ items: { id: string }[] }>("/data/quarantine-names.json").catch(() => ({ items: [] })))
      .items.map((x) => x.id),
  );
  const ingredients = quarantinedIds.size ? ingPayload.rows.filter((i) => !quarantinedIds.has(i.id)) : ingPayload.rows;

  // 식별 판단기(Gemini consensus)가 '동일물질 확정'한 형제 링크 — 결정론으로 못 가른 같은 한글명
  // 표기변형을 병합(예: Manganese Violet 변형). data-loader 가 형제로 읽어 규제 통합·대표명 통일.
  const identityLinks = new Map<string, string[]>();
  for (const pr of (await fetchJson<{ pairs: { ids: string[] }[] }>("/data/identity-overrides.json").catch(() => ({ pairs: [] }))).pairs ?? []) {
    if (!pr.ids || pr.ids.length < 2) continue;
    for (const a of pr.ids) for (const b of pr.ids) if (a !== b) {
      let s = identityLinks.get(a); if (!s) { s = []; identityLinks.set(a, s); } if (!s.includes(b)) s.push(b);
    }
  }
  const countries = ctyPayload.rows;
  const quarantine = quarPayload.rows;

  // 번역 캐시 — strKey(원문) → 한국어. 없으면 빈 맵(결정론 seed 만으로도 동작).
  const translations = new Map<string, string>();
  {
    const tj = await fetchJson<{ translations?: Record<string, string> }>("/data/translations.json").catch(() => ({ translations: {} as Record<string, string> }));
    const tobj: Record<string, string> = tj.translations ?? {};
    for (const k of Object.keys(tobj)) translations.set(k, tobj[k]);
  }

  const regPayloads = await Promise.all(
    countries.map((c) =>
      fetchJson<{ rows: Regulation[] }>(`/data/regulations/${c.code}.json`).catch(() => ({ rows: [] })),
    ),
  );
  const regulations: Regulation[] = regPayloads.flatMap((p) => p.rows);

  // status 판단기(Gemini consensus)가 'restricted' 로 확정한 banned 오분류 교정 — "사용제한 자료"가
  // 실제 제한물질을 banned 로 잘못 매핑한 행(과산화수소형)만 restricted 로 바로잡음. 금지annex veto·
  // uncertain 은 제외(파라벤형 금지물질을 허용으로 바꾸지 않음). 원본 JSON 무변경(가역) — 로드시 적용.
  type StatusCorrection = { ingredient_id: string; country_code: string; from: string; to: string; source_match?: string; reason?: string };
  const statusCorr = new Map<string, StatusCorrection>();
  for (const c of (await fetchJson<{ corrections: StatusCorrection[] }>("/data/status-overrides.json").catch(() => ({ corrections: [] }))).corrections ?? []) {
    if (c?.ingredient_id && c?.country_code) statusCorr.set(`${c.ingredient_id}:${c.country_code}`, c);
  }
  if (statusCorr.size) {
    for (const r of regulations) {
      const c = statusCorr.get(`${r.ingredient_id}:${r.country_code}`);
      if (!c || r.status !== c.from) continue;
      if (c.source_match && !(r.source_document ?? "").includes(c.source_match)) continue;
      r.status = c.to;
      r.override_note = r.override_note ?? `status 교정(${c.from}→${c.to}): ${c.reason ?? "사용제한 자료 오분류"}`;
    }
  }

  const ingredientById = new Map<string, Ingredient>();
  const ingredientByInciLower = new Map<string, Ingredient>();
  const ingredientByKoreanLower = new Map<string, Ingredient>();
  const ingredientByCas = new Map<string, Ingredient>();
  const idsByKoreanLower = new Map<string, string[]>();

  // 청크 단위 yield — main thread 5ms 마다 양보 → TBT 감소.
  // 33K ingredients × 4 Map ops + 91K regulations 인덱싱이 한 번에 끊기지 않게.
  const yieldEvery = 5000;
  for (let idx = 0; idx < ingredients.length; idx++) {
    const i = ingredients[idx];
    ingredientById.set(i.id, i);
    if (i.inci_name) ingredientByInciLower.set(i.inci_name.toLowerCase(), i);
    if (i.korean_name) {
      const kl = i.korean_name.toLowerCase();
      ingredientByKoreanLower.set(kl, i);
      const arr = idsByKoreanLower.get(kl);
      if (arr) arr.push(i.id); else idsByKoreanLower.set(kl, [i.id]);
    }
    if (i.cas_no) {
      for (const cas of i.cas_no.split(/[\s,;/]+/)) {   // 쉼표/세미콜론/슬래시 분리(다중 CAS 검색 도달)
        const t = cas.trim().replace(/\(.*$/, "");      // 토큰 끝 주석 strip("68439-49-6(Generic)" 글루)
        if (t) ingredientByCas.set(t, i);
      }
    }
    if (idx > 0 && idx % yieldEvery === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  const regsByIngredientCountry = new Map<string, Map<string, Regulation[]>>();
  for (let idx = 0; idx < regulations.length; idx++) {
    const r = regulations[idx];
    let inner = regsByIngredientCountry.get(r.ingredient_id);
    if (!inner) {
      inner = new Map();
      regsByIngredientCountry.set(r.ingredient_id, inner);
    }
    let bucket = inner.get(r.country_code);
    if (!bucket) {
      bucket = [];
      inner.set(r.country_code, bucket);
    }
    bucket.push(r);
    if (idx > 0 && idx % yieldEvery === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  // 각 bucket 정렬: source_priority desc → last_verified_at desc.
  // lookup 시 [0] 이 1차 우선. 자국 1차 소스가 들어오면 자동으로 MFDS 위로 올라감.
  let sortedSinceYield = 0;
  for (const inner of regsByIngredientCountry.values()) {
    for (const bucket of inner.values()) {
      bucket.sort((a, b) => {
        const pa = a.source_priority ?? 0;
        const pb = b.source_priority ?? 0;
        if (pa !== pb) return pb - pa;
        return (b.last_verified_at ?? "").localeCompare(a.last_verified_at ?? "");
      });
      if (++sortedSinceYield >= yieldEvery) {
        sortedSinceYield = 0;
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  }

  // 형제 id 묶음 — 같은 물질의 표기차 중복(F5). 정규화 INCI(대소문자·공백·구두점 통일) 또는
  // 동일 CAS 를 공유하면 같은 물질로 간주. 규제 분절 보정용 (lookup 이 형제 전부의 규제 합산).
  // 그리스 문자 → 영문 (유한·고정 집합이라 결정론적. 예: "α-Hydroxy" ↔ "Alpha-Hydroxy").
  const GREEK: Record<string, string> = {
    "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ζ": "zeta",
    "η": "eta", "θ": "theta", "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "mu",
    "ν": "nu", "ξ": "xi", "ο": "omicron", "π": "pi", "ρ": "rho", "σ": "sigma",
    "τ": "tau", "υ": "upsilon", "φ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega",
  };
  // 정규화: 소문자 + 그리스문자 + 세미콜론/전각괄호 통일 + 공백·쉼표 정리.
  const normKey = (s: string) =>
    s.toLowerCase()
      .replace(/[αβγδεζηθικλμνξοπρστυφχψω]/g, (m) => GREEK[m] ?? m)  // 그리스 → 영문
      .replace(/[；;]/g, ",")                                   // 세미콜론 → 쉼표 (동의어 구분자 통일)
      .replace(/[（）]/g, (m) => (m === "（" ? "(" : ")"))        // 전각 괄호 → 반각
      .replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim();
  // 표준 canonical 키 = 정규화 + 구조화 메타데이터(이름 아님) 제거. CosIng 도 별도 필드로 둠.
  // 같은 물질이 소스마다 "Zinc Oxide, CI 77947"/"ZINC OXIDE", "...(CAS No. 8024-12-2)" 유무로
  // 달리 들어와 분절되던 것을 결정론적으로 통합 — 향후 데이터에도 자동 적용(케이스별 alias 불필요).
  const canonName = (s: string) =>
    normKey(s)
      .replace(/[,\s]*\(\s*cas\s*(?:no\.?)?\s*[\d\-,\s/]+\)/g, "")   // "(CAS No. …)" 주석 제거
      .replace(/[,\s]+c\.?i\.?\s*\d{4,6}/g, "")                       // ", CI #####" 색인 제거
      .replace(/[,\s]+$/, "").replace(/^[,\s]+/, "").trim();
  // CAS 는 반드시 유효 형식(예: 68-26-8)만 형제 키로 사용. cas_no 에는 "0"·"(generic)"·"Yellow"
  // 같은 파싱 아티팩트가 섞여 있어, 이를 키로 쓰면 무관한 원료가 대거 오병합됨(정품검증서 발견).
  const isValidCas = (c: string) => /^\d{1,7}-\d{2}-\d$/.test(c);
  // 구분자 쉼표/세미콜론/슬래시(소스가 "A/B/C" 다중 CAS 표기) + 토큰 끝 주석 strip("68439-49-6(Generic)"
  // 글루·"(L-)/(cis-)" 등) → 유효 CAS 추출. 다중 CAS 형제링크 누락(분절·권위 도달 누락) 방지.
  const casTokens = (raw: string) => raw.split(/[\s,;/]+/).map((c) => c.trim().replace(/\(.*$/, "")).filter(isValidCas);
  // 동의어-리스트 접두 규칙: 같은 한글명 + 한 canonName 이 다른 것의 '동의어 경계(쉼표/세미콜론)
  // 접두'. 예: "Amaranth" ⊂ "Amaranth, Acid Red 27, CI 16185". 한 소스는 기본명, 다른 소스는
  // 동의어를 덧붙여 분절되던 것을 통합. 경계를 쉼표/세미콜론으로 한정 → "Silver Chloride" 와
  // "Silver Chloride Deposited on TiO2"(공백+다른물질) 같은 오병합 차단(측정으로 위험 0 확인).
  const isSynPrefix = (a: string, b: string) => {
    const sh = a.length <= b.length ? a : b, lo = a.length <= b.length ? b : a;
    if (!sh || sh.length < 5 || sh === lo || !lo.startsWith(sh)) return false;
    return /[,;]/.test(lo[sh.length]);
  };
  // 정규화 영문키: 대소문자·공백·구두점·복수 s 제거. 같은 한글표준명 + 이 키가 완전히 같으면
  // 동일물질의 표기변형(HC Red No. 1=HC RED NO.1, Polyacrylamide=POLYACRYLAMIDES)으로 보고 병합.
  // 종/부위 다른 것(Lavandula Angustifolia vs Spica)은 키가 달라 안 걸림 → 오병합 0. 한글명 co-제약이
  // 안전 앵커. (이전엔 쉼표경계 접두만 잡아 대소문자/복수 변형이 분절돼 규제가 쪼개지던 것 보정.)
  const neKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
  const nameToIds = new Map<string, string[]>();
  const casToIds = new Map<string, string[]>();
  const neKorToIds = new Map<string, string[]>();
  const codeToIds = new Map<string, string[]>();   // KCIA 코드 = 권위 동일성 키
  const korToIngr = new Map<string, { id: string; cn: string }[]>();
  const push = (m: Map<string, string[]>, k: string, id: string) => {
    const arr = m.get(k);
    if (arr) arr.push(id);
    else m.set(k, [id]);
  };
  for (const i of ingredients) {
    const cn = i.inci_name ? canonName(i.inci_name) : "";
    if (cn) push(nameToIds, cn, i.id);
    if (i.cas_no) for (const c of casTokens(i.cas_no)) push(casToIds, c, i.id);
    if (i.kcia_code) push(codeToIds, String(i.kcia_code).trim(), i.id);
    if (i.korean_name) {
      const ne = i.inci_name ? neKey(i.inci_name) : "";
      if (ne && ne.length >= 4) push(neKorToIds, ne + "|" + i.korean_name.trim(), i.id);
    }
    if (i.korean_name && cn) {
      const k = i.korean_name.trim();
      const arr = korToIngr.get(k);
      if (arr) arr.push({ id: i.id, cn });
      else korToIngr.set(k, [{ id: i.id, cn }]);
    }
  }
  const siblingIds = new Map<string, string[]>();
  for (const i of ingredients) {
    const set = new Set<string>([i.id]);
    const cn = i.inci_name ? canonName(i.inci_name) : "";
    if (cn) for (const id of nameToIds.get(cn) ?? []) set.add(id);
    if (i.cas_no) for (const c of casTokens(i.cas_no)) for (const id of casToIds.get(c) ?? []) set.add(id);
    if (i.kcia_code) for (const id of codeToIds.get(String(i.kcia_code).trim()) ?? []) set.add(id);  // 같은 KCIA 코드 = 같은 성분
    for (const id of identityLinks.get(i.id) ?? []) set.add(id);  // Gemini consensus 동일물질 링크
    if (i.korean_name) {
      const ne = i.inci_name ? neKey(i.inci_name) : "";
      if (ne && ne.length >= 4) for (const id of neKorToIds.get(ne + "|" + i.korean_name.trim()) ?? []) set.add(id);
    }
    if (i.korean_name && cn) {
      for (const e of korToIngr.get(i.korean_name.trim()) ?? []) {
        if (e.id !== i.id && isSynPrefix(cn, e.cn)) set.add(e.id);
      }
    }
    if (set.size > 1) siblingIds.set(i.id, Array.from(set));
  }

  const countryByCode = new Map<string, Country>();
  for (const c of countries) countryByCode.set(c.code, c);

  const quarantineByCountryName = new Map<string, Map<string, QuarantineRow>>();
  for (const q of quarantine) {
    let inner = quarantineByCountryName.get(q.country_code);
    if (!inner) {
      inner = new Map();
      quarantineByCountryName.set(q.country_code, inner);
    }
    inner.set(q.ingredient_name_raw.toLowerCase(), q);
  }

  const kciaArticles = kciaPayload.rows;
  const kciaByCountry = new Map<string, KciaArticle[]>();
  for (const a of kciaArticles) {
    if (!a.country_inferred) continue;
    let bucket = kciaByCountry.get(a.country_inferred);
    if (!bucket) { bucket = []; kciaByCountry.set(a.country_inferred, bucket); }
    bucket.push(a);
  }
  for (const bucket of kciaByCountry.values()) {
    bucket.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }

  const sourcePdfs = srcPdfPayload.rows;
  const sourcePdfsByCountry = new Map<string, SourcePdf[]>();
  for (const p of sourcePdfs) {
    let bucket = sourcePdfsByCountry.get(p.country);
    if (!bucket) { bucket = []; sourcePdfsByCountry.set(p.country, bucket); }
    bucket.push(p);
  }

  return {
    meta: metaPayload,
    ingredients,
    ingredientById,
    ingredientByInciLower,
    ingredientByKoreanLower,
    ingredientByCas,
    idsByKoreanLower,
    regsByIngredientCountry,
    siblingIds,
    countries,
    countryByCode,
    quarantineByCountryName,
    kciaByCountry,
    sourcePdfsByCountry,
    translations,
  };
}

export function dataset(): Promise<Dataset> {
  if (!cached) cached = loadDataset();
  return cached;
}

// SSR-safe prefetch — 사용자 명시 인터랙션(pointerdown / keydown)에만 시작.
// scroll·focusin 제외: app/page.tsx 의 autoFocus 가 hydration 직후 focusin 을 트리거하는데
// Lighthouse 측정 윈도우에 데이터 로딩이 같이 들어가 TBT 1.3s+ 됨. autoFocus 직후 사용자
// 가 keydown/click 으로 검색을 시작하면 그 시점에 prefetch 시작 — 1초 정도 추가 wait.
if (typeof window !== "undefined") {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void dataset().catch(() => {
      cached = null;
      started = false;
    });
  };
  const events = ["pointerdown", "keydown"] as const;
  for (const ev of events) {
    document.addEventListener(ev, start, { capture: true, once: true, passive: true });
  }
}
