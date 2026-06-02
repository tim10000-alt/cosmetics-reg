import { randomUUID } from "node:crypto";
import { loadEnv } from "../crawlers/env";
loadEnv();

import { fetchAllPages } from "./client";
import { mapCountryName, getUnknownCountries } from "./country-mapping";
import type {
  IngredientMasterItem,
  UseRestrictionItem,
  CountryDetailItem,
} from "./types";
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// Phase 5b — Supabase 제거. 식약처 API → public/data/*.json 직접 머지.
// 기존 ingredients 의 function_category / function_description / 다국어명 보존.
// regulations 는 source_document 가 MFDS_PREFIX 로 시작하는 행만 교체 (다른 source 보존).

const MFDS_PREFIX = "MFDS 공공데이터";
const SOURCE_URL_BASE = "https://www.data.go.kr/data";

// source_document 명확화 — country 별 분리:
//   KR: "MFDS 공공데이터 API (식약처 사용제한 원료 직접)"  → 1차 (priority 100)
//   그 외: "MFDS 공공데이터 — 한국 식약처가 정리한 [국가명] 사용제한 자료" → 3차 (priority 50)
// 사용자가 UI에서 "이게 한국 정리본인지 해당국 공식 직접인지" 즉시 구분 가능.
function mfdsSourceDoc(code: string, nameKo: string): string {
  if (code === "KR") return "MFDS 공공데이터 API (식약처 사용제한 원료 직접)";
  return `MFDS 공공데이터 — 한국 식약처가 정리한 ${nameKo} 사용제한 자료`;
}

interface CanonicalIngredient {
  inci_name: string;
  korean_name: string | null;
  chinese_name: string | null;
  japanese_name: string | null;
  cas_no: string | null;
  synonyms: string[];
  description: string | null;
}

interface IngredientRow {
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

interface CountryRow {
  code: string;
  name_ko: string;
  inherits_from: string | null;
  regulation_type: string;
  registry_url?: string | null;   // positive_list/hybrid 국가 — 등록 원료 검색 가능 공식 사이트
  registry_name?: string | null;  // 사이트 표시명 (UI 노출용)
}

interface RegulationRow {
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
  source_priority: number;       // 100 = 자국 1차, 50 = 타국이 정리한 자료, 30 = AI 파싱
  last_verified_at: string;
  confidence_score: number;
  override_note: string | null;
}

// 자국 데이터(KR 행)는 MFDS 가 1차 소스라 priority 100.
// 타국 데이터(EU/US/JP 등)는 MFDS 가 자체 정리한 자료라 priority 50 — 해당국 1차 소스
// (CosIng/FDA/MHLW 등)이 들어오면 자동으로 우선됨.
function mfdsSourcePriority(country_code: string): number {
  return country_code === "KR" ? 100 : 50;
}

function parseSynonyms(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;\n\r/]|,\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeInci(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// F5: 같은 원료를 표기차(대소문자·공백·구두점)로 다른 id 로 만들지 않기 위한 정규화 키.
// 예: "Magnesium Ascorbyl Phosphate" / "magnesium ascorbyl phosphate" /
//     "Magnesium Carbonate,CI 77713" / "Magnesium Carbonate, CI 77713" → 동일 키.
function normKey(s: string): string {
  return s.toLowerCase().replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim();
}

function stage1IngredientMaster(ing: IngredientMasterItem[]): Map<string, CanonicalIngredient> {
  const byInci = new Map<string, CanonicalIngredient>();
  let skippedNoEng = 0;
  for (const row of ing) {
    const inci = normalizeInci(row.INGR_ENG_NAME);
    if (!inci) { skippedNoEng++; continue; }
    const korean = normalizeInci(row.INGR_KOR_NAME);
    const existing = byInci.get(inci);
    const synonyms = parseSynonyms(row.INGR_SYNONYM);
    byInci.set(inci, {
      inci_name: inci,
      korean_name: existing?.korean_name ?? korean,
      chinese_name: existing?.chinese_name ?? null,
      japanese_name: existing?.japanese_name ?? null,
      cas_no: existing?.cas_no ?? normalizeInci(row.CAS_NO),
      synonyms: Array.from(new Set([...(existing?.synonyms ?? []), ...synonyms])),
      description: existing?.description ?? row.ORIGIN_MAJOR_KOR_NAME,
    });
  }
  console.log(`  master: ${ing.length} raw → ${byInci.size} unique INCI (skipped ${skippedNoEng})`);
  return byInci;
}

function mergeRestrictionIngredients(map: Map<string, CanonicalIngredient>, rows: UseRestrictionItem[]) {
  let skippedNoEng = 0;
  for (const r of rows) {
    const inci = normalizeInci(r.INGR_ENG_NAME);
    if (!inci) { skippedNoEng++; continue; }
    const existing = map.get(inci);
    const synonyms = parseSynonyms(r.INGR_SYNONYM);
    const korean = normalizeInci(r.INGR_STD_NAME);
    const cas = normalizeInci(r.CAS_NO);
    if (existing) {
      existing.korean_name = existing.korean_name ?? korean;
      existing.cas_no = existing.cas_no ?? cas;
      existing.synonyms = Array.from(new Set([...existing.synonyms, ...synonyms]));
    } else {
      map.set(inci, {
        inci_name: inci,
        korean_name: korean,
        chinese_name: null,
        japanese_name: null,
        cas_no: cas,
        synonyms,
        description: null,
      });
    }
  }
  if (skippedNoEng) console.log(`    (restriction skipped ${skippedNoEng})`);
}

function mapRegulateType(t: string, limitCond?: string | null, provis?: string | null): RegulationRow["status"] {
  const bannedRe = /금지|배합금지|ban|prohibit/i;
  const restrictedRe = /제한|배합한도|limit|restric|maximum|최대/i;
  // "금지" 분류라도 LIMIT_COND/PROVIS_ATRCL 에 한정 키워드가 있으면 "조건부 사용 가능"
  // (restricted) 로 재분류. 사용자가 conditions 의 단서 조항을 놓치지 않도록.
  const conditionalRe = /단[,，\s]|다만|제외|except|only|에 한[하해]|할 수 있다|허용/i;
  const aux = `${limitCond ?? ""}\n${provis ?? ""}`;

  if (bannedRe.test(t)) {
    if (conditionalRe.test(aux)) return "restricted";
    return "banned";
  }
  if (restrictedRe.test(t)) return "restricted";
  if (bannedRe.test(aux)) {
    if (conditionalRe.test(aux)) return "restricted";
    return "banned";
  }
  if (restrictedRe.test(aux)) return "restricted";
  return "unknown";
}

// 한글 포함 여부.
function hasKorean(s: string): boolean {
  return /[가-힣]/.test(s);
}

// 영문/CJK 라인이 한글 번역과 병렬로 반복되는 패턴이 MFDS API 의 EU/JP/CN 데이터에 흔함.
// 예: "* 【Restrictions】\n... \n* 【제한】\n..." 또는 "すべての化粧品(모든 화장품)".
//
// 휴리스틱: 한글 라인 비율이 25% 이상이면 한글 없는 라인 제거 (한글 번역으로 충분히 표현됨).
// 한글 비율 낮으면 (= 한글 번역 누락) 그대로 — 정보 손실 방지.
function preferKoreanLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return text;
  const koreanCount = nonEmpty.filter(hasKorean).length;
  const ratio = koreanCount / nonEmpty.length;
  if (ratio < 0.25) return text; // 한글 번역이 거의 없음 — 원문 보존
  return lines.filter((l) => l.trim().length === 0 || hasKorean(l)).join("\n");
}

// "原文(한글 번역)" 패턴에서 괄호 안 한글만 추출. 예: "すべての化粧品(모든 화장품)" → "모든 화장품".
function extractKoreanFromParens(text: string): string {
  return text.replace(/[一-龯ぁ-んァ-ヴa-zA-Z][^()]*\(([^()]*[가-힣][^()]*)\)/g, "$1");
}

// conditions 정리 — trim, 빈 줄 압축, 중복 텍스트 제거 + 영문/CJK 라인 정리.
function normalizeConditionText(s: string): string {
  let text = s
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  text = extractKoreanFromParens(text);
  text = preferKoreanLines(text);
  return text;
}

// 같은 ingredient×country 에 여러 row 가 머지될 때, 각 row 의 conditions 를
// 별도 항목으로 누적 + 동일 텍스트 중복 방지.
function appendCondition(existing: string | null, addition: string | null): string | null {
  if (!addition) return existing;
  const norm = normalizeConditionText(addition);
  if (!norm) return existing;
  if (!existing) return norm;
  // 이미 동일 텍스트(또는 substring) 가 들어있으면 skip.
  if (existing.includes(norm) || norm.includes(existing)) return existing;
  return `${existing}\n\n${norm}`;
}

function buildRegulationsFromRestriction(
  rows: UseRestrictionItem[],
  idByInci: Map<string, string>,
  sourceVersion: string,
  countryNameByCode: Map<string, string>,
): RegulationRow[] {
  const merged = new Map<string, RegulationRow>();
  const now = new Date().toISOString();
  let skipped = 0;
  for (const r of rows) {
    const inci = normalizeInci(r.INGR_ENG_NAME);
    if (!inci) { skipped++; continue; }
    const ingredient_id = idByInci.get(normKey(inci));   // F5: 정규화 키로 조회
    if (!ingredient_id) { skipped++; continue; }
    const codes = mapCountryName(r.COUNTRY_NAME);
    if (codes.length === 0) continue;
    const status = mapRegulateType(r.REGULATE_TYPE, r.LIMIT_COND, r.PROVIS_ATRCL);
    const conditionsParts = [r.LIMIT_COND, r.PROVIS_ATRCL]
      .filter(Boolean)
      .map((s) => normalizeConditionText(String(s)));
    const conditions = conditionsParts.length > 0 ? conditionsParts.join("\n") : null;

    for (const code of codes) {
      const key = `${ingredient_id}:${code}`;
      const existing = merged.get(key);
      if (existing) {
        // 핵심: banned + restricted 조합은 단순 banned 가 아닌 restricted (조건부 허용)
        // 가 더 정확. 사용자가 "특정 제품에서만 금지" 정보를 잃지 않도록 conditions 에 마킹.
        const wasBan = existing.status === "banned";
        const nowBan = status === "banned";
        const wasRest = existing.status === "restricted";
        const nowRest = status === "restricted";

        let mergedStatus = existing.status;
        let prefix: string | null = null;

        if (wasBan && nowBan) {
          mergedStatus = "banned";
        } else if ((wasBan && nowRest) || (wasRest && nowBan)) {
          mergedStatus = "restricted";
          prefix = "[일부 제품·조건은 금지]";
        } else if (wasRest || nowRest) {
          mergedStatus = "restricted";
        } else if (wasBan || nowBan) {
          mergedStatus = "banned";
        }

        existing.status = mergedStatus;
        const tagged = prefix && conditions ? `${prefix}\n${conditions}` : conditions;
        existing.conditions = appendCondition(existing.conditions, tagged);
      } else {
        merged.set(key, {
          ingredient_id,
          country_code: code,
          status,
          max_concentration: null,
          concentration_unit: "%",
          product_categories: [],
          conditions,
          source_url: SOURCE_URL_BASE,
          source_document: mfdsSourceDoc(code, countryNameByCode.get(code) ?? code),
          source_version: sourceVersion,
          source_priority: mfdsSourcePriority(code),
          last_verified_at: now,
          confidence_score: 0.95,
          override_note: null,
        });
      }
    }
  }
  if (skipped) console.log(`    (regulation skipped ${skipped})`);
  return Array.from(merged.values());
}

function enrichRegulationsWithDetail(regulations: RegulationRow[], details: CountryDetailItem[], idByInci: Map<string, string>) {
  const regIndex = new Map<string, RegulationRow>();
  for (const r of regulations) regIndex.set(`${r.ingredient_id}:${r.country_code}`, r);
  let matched = 0, unmatched = 0;
  for (const d of details) {
    if (!d.NOTICE_INGR_NAME) continue;
    const possibleInci = d.NOTICE_INGR_NAME.split(/[;,\n]/)[0].trim();
    const codes = mapCountryName(d.COUNTRY_NAME);
    if (codes.length === 0) continue;
    let ingredient_id: string | undefined;
    const possibleKey = normKey(possibleInci);                  // F5: 정규화 키 비교
    for (const [inci, id] of idByInci.entries()) {
      if (possibleKey.startsWith(inci)) {
        ingredient_id = id;
        break;
      }
    }
    if (!ingredient_id) { unmatched++; continue; }
    for (const code of codes) {
      const reg = regIndex.get(`${ingredient_id}:${code}`);
      if (reg) {
        const detailParts = [d.LIMIT_COND, d.PROVIS_ATRCL]
          .filter(Boolean)
          .map((s) => normalizeConditionText(String(s)));
        if (detailParts.length > 0) {
          const detailText = detailParts.join("\n");
          reg.conditions = appendCondition(reg.conditions, detailText);
        }
        matched++;
      }
    }
  }
  console.log(`    detail enrichment: ${matched} matched, ${unmatched} unmatched`);
}

const ADDITIONAL_COUNTRIES: CountryRow[] = [
  { code: "TW", name_ko: "대만", inherits_from: null, regulation_type: "positive_list" },
  { code: "BR", name_ko: "브라질", inherits_from: null, regulation_type: "negative_list" },
  { code: "AR", name_ko: "아르헨티나", inherits_from: null, regulation_type: "negative_list" },
  { code: "CA", name_ko: "캐나다", inherits_from: null, regulation_type: "negative_list" },
];

async function ensureCountries() {
  const existing = await readRows<CountryRow>("countries");
  if (existing.length === 0) {
    // Bootstrap — first run with no DB seed. 15-country base list (regulation_type defaults).
    const base: CountryRow[] = [
      { code: "KR", name_ko: "한국", inherits_from: null, regulation_type: "negative_list" },
      { code: "CN", name_ko: "중국", inherits_from: null, regulation_type: "positive_list" },
      { code: "EU", name_ko: "EU", inherits_from: null, regulation_type: "hybrid" },
      { code: "US", name_ko: "미국", inherits_from: null, regulation_type: "negative_list" },
      { code: "JP", name_ko: "일본", inherits_from: null, regulation_type: "hybrid" },
      { code: "VN", name_ko: "베트남", inherits_from: "EU", regulation_type: "hybrid" },
      { code: "TH", name_ko: "태국", inherits_from: "EU", regulation_type: "hybrid" },
      { code: "ID", name_ko: "인도네시아", inherits_from: "EU", regulation_type: "hybrid" },
      { code: "MY", name_ko: "말레이시아", inherits_from: "EU", regulation_type: "hybrid" },
      { code: "PH", name_ko: "필리핀", inherits_from: "EU", regulation_type: "hybrid" },
      { code: "SG", name_ko: "싱가포르", inherits_from: "EU", regulation_type: "hybrid" },
      ...ADDITIONAL_COUNTRIES,
    ];
    await writeRows("countries", base);
    return base;
  }
  const codes = new Set(existing.map((c) => c.code));
  let changed = false;
  for (const a of ADDITIONAL_COUNTRIES) {
    if (!codes.has(a.code)) { existing.push(a); changed = true; }
  }
  if (changed) await writeRows("countries", existing);
  return existing;
}

async function main() {
  const startedAt = Date.now();
  console.log("▶ [0/5] countries.json bootstrap...");
  const countries = await ensureCountries();

  console.log("▶ [1/5] Fetching ingredient master...");
  const ingMaster = await fetchAllPages<IngredientMasterItem>(
    "CsmtcsIngdCpntInfoService01",
    "getCsmtcsIngdCpntInfoService01",
    { onProgress: (l, t) => { if (l % 2000 === 0 || l === t) console.log(`    ${l}/${t}`); } },
  );

  console.log("▶ [2/5] Fetching restrictions...");
  const restrictions = await fetchAllPages<UseRestrictionItem>(
    "CsmtcsUseRstrcInfoService",
    "getCsmtcsUseRstrcInfoService",
    { onProgress: (l, t) => { if (l % 3000 === 0 || l === t) console.log(`    ${l}/${t}`); } },
  );

  console.log("▶ [3/5] Fetching country-detail...");
  const details = await fetchAllPages<CountryDetailItem>(
    "CsmtcsUseRstrcInfoService",
    "getCsmtcsUseRstrcNatnInfoService",
    { onProgress: (l, t) => { if (l % 2000 === 0 || l === t) console.log(`    ${l}/${t}`); } },
  );

  console.log("▶ [4/5] Building canonical ingredients + merging into ingredients.json...");
  const canonicalRaw = stage1IngredientMaster(ingMaster);
  mergeRestrictionIngredients(canonicalRaw, restrictions);

  // F5: canonical 을 정규화 키로 합쳐 한 run 안의 표기차 중복(같은 원료 복수 id)을 차단.
  const canonical = new Map<string, CanonicalIngredient>();   // key = normKey(inci)
  for (const c of canonicalRaw.values()) {
    const nk = normKey(c.inci_name);
    const ex = canonical.get(nk);
    if (!ex) { canonical.set(nk, { ...c, synonyms: [...c.synonyms] }); continue; }
    ex.korean_name = ex.korean_name ?? c.korean_name;
    ex.chinese_name = ex.chinese_name ?? c.chinese_name;
    ex.japanese_name = ex.japanese_name ?? c.japanese_name;
    ex.cas_no = ex.cas_no ?? c.cas_no;
    ex.synonyms = Array.from(new Set([...ex.synonyms, ...c.synonyms]));
    ex.description = ex.description ?? c.description;
  }

  // Load existing ingredients to preserve id, function_category, multi-language names from prior enrichment.
  // F5: 기존 id 를 정규화 키로 재사용 → 표기차로 새 id 가 발급돼 규제가 분절되는 것을 방지.
  const existingIngredients = await readRows<IngredientRow>("ingredients");
  const existingByNorm = new Map<string, IngredientRow>();    // first-wins by normalized key
  for (const e of existingIngredients) {
    const nk = normKey(e.inci_name);
    if (!existingByNorm.has(nk)) existingByNorm.set(nk, e);
  }

  const mergedIngredients: IngredientRow[] = [];
  const idByInci = new Map<string, string>();   // key = normKey(inci) — buildRegulations/enrich 가 normKey 로 조회
  const assignedIds = new Set<string>();
  for (const [nk, c] of canonical) {
    const prev = existingByNorm.get(nk);
    const id = prev?.id ?? randomUUID();
    if (prev) assignedIds.add(prev.id);
    idByInci.set(nk, id);
    mergedIngredients.push({
      id,
      inci_name: c.inci_name,
      korean_name: c.korean_name ?? prev?.korean_name ?? null,
      chinese_name: prev?.chinese_name ?? c.chinese_name,
      japanese_name: prev?.japanese_name ?? c.japanese_name,
      cas_no: c.cas_no ?? prev?.cas_no ?? null,
      synonyms: Array.from(new Set([...(c.synonyms ?? []), ...(prev?.synonyms ?? [])])),
      description: prev?.description ?? c.description,
      // 보강 결과(Gemini) 보존
      function_category: prev?.function_category ?? null,
      function_description: prev?.function_description ?? null,
    });
  }
  // 기존에 있었으나 이번 canonical 이 대표하지 않은(id 미사용) 행 — 유지 (타 소스·과거 데이터의
  // 규제가 그 id 를 참조하므로 drop 시 고아 발생). 기존 중복은 보존하되 새로 늘리지 않음.
  for (const e of existingIngredients) {
    if (assignedIds.has(e.id)) continue;     // canonical 이 이미 이 id 를 재사용 = 대표됨
    mergedIngredients.push(e);
    const nk = normKey(e.inci_name);
    if (!idByInci.has(nk)) idByInci.set(nk, e.id);
  }
  await writeRows("ingredients", mergedIngredients);
  console.log(`  ingredients.json: ${mergedIngredients.length} rows (canonical ${canonical.size} + retained ${mergedIngredients.length - canonical.size})`);

  console.log("▶ [5/5] Building regulations + replacing MFDS rows...");
  const runDate = new Date().toISOString().slice(0, 10);
  const sourceVersion = `MFDS-${runDate}`;
  const countryNameByCode = new Map(countries.map((c) => [c.code, c.name_ko]));
  const newMfdsRegs = buildRegulationsFromRestriction(restrictions, idByInci, sourceVersion, countryNameByCode);
  if (details.length > 0) enrichRegulationsWithDetail(newMfdsRegs, details, idByInci);

  const existingRegs = await readRows<RegulationRow>("regulations");
  // 모든 MFDS source 행 (이전 단일 SOURCE_DOC + 새 국가별 분리 양식 모두) 제거 후 새로 insert
  const nonMfds = existingRegs.filter((r) =>
    r.source_document !== "MFDS 공공데이터 API" && !r.source_document.startsWith(MFDS_PREFIX),
  );
  const finalRegs = [...nonMfds, ...newMfdsRegs];
  await writeRows("regulations", finalRegs);
  console.log(`  regulations.json: ${finalRegs.length} rows (MFDS ${newMfdsRegs.length} + other-sources ${nonMfds.length})`);

  await updateMeta({
    countries: countries.length,
    ingredients: mergedIngredients.length,
    regulations: finalRegs.length,
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const unknown = getUnknownCountries();
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  countries: ${countries.length}`);
  console.log(`  ingredients: ${mergedIngredients.length}`);
  console.log(`  regulations: ${finalRegs.length} (MFDS ${newMfdsRegs.length})`);
  if (unknown.length > 0) console.log(`  unknown country names: ${unknown.join(", ")}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
