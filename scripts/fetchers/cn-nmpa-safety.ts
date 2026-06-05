import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";
import XLSX from "xlsx";

// CN NMPA 화장품안전기술규범 (2015년판) — KCIA 한국어 번역본 Excel 파싱.
// 출처: https://kcia.or.kr/home/law/law_09.php?type=view&no=14208
// 첨부 파일: public/data/raw-attach/kcia-14208/cn_safety_ingredients_kr.xlsx
//
// 7 시트:
//  표1: 사용금지 물질 ~1294건 → status=banned
//  표2: 사용금지 식(동)물 ~100건 → status=banned
//  표3: 사용제한 물질 ~83건 → status=restricted
//  표4: 준용 방부제 ~56건 → status=listed, function_category=방부제
//  표5: 준용 자외선차단제 ~28건 → status=listed, function_category=자외선차단제
//  표6: 준용 착색제 ~158건 → status=listed, function_category=색소
//  표7: 준용 염모제 ~76건 → status=listed, function_category=색소

const SOURCE_DOC = "KCIA NMPA 화장품안전기술규범 (2015년판) 한국어 번역본";
const SOURCE_URL = "https://kcia.or.kr/home/law/law_09.php?type=view&no=14208";

const XLSX_PATHS = [
  "public/data/raw-attach/kcia-14208/cn_safety_ingredients_kr.xlsx",
  ".crawl-raw/kcia-14208/cn_safety_ingredients_kr.xlsx",
];

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
  source_priority: number;
  last_verified_at: string;
  confidence_score: number;
  override_note: string | null;
}

interface Entry {
  inci: string;             // INCI 또는 영문/라틴학명
  korean: string | null;
  chinese: string | null;
  cas: string | null;
  ci: string | null;        // 표6 CI 번호
  status: "banned" | "restricted" | "listed";
  max_concentration: number | null;
  conditions: string;
  function_category: string | null;
}

function extractCas(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{1,7}-\d{2}-\d)/);
  return m?.[1] ?? null;
}

function clean(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

function extractInciFromEnglish(eng: string): string {
  // 소스가 "(INCI: X)" 로 표준 INCI 를 명시하면 그걸 우선 사용(가장 권위). 미사용 시 매칭 실패로
  // banned 행이 엉뚱한 이름에 붙어 금지물질이 listed 로 보이던 안전결함(예: Isobutylparaben) 수정.
  const inciTag = eng.match(/\(INCI:\s*([^);]+)\)?/i);
  if (inciTag && inciTag[1].trim()) return inciTag[1].trim();
  // "1-((3-Aminopropyl)amino)-...anthraquinone (CAS No. 22366-99-0) and its salts" → 본체명
  return eng.replace(/\(CAS\s*No\.\s*[\d-]+\)/gi, "")
    .replace(/and its salts?/gi, "").trim();
}

function parseAmount(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

// 표1: row=4부터, [순번, 중문, 영문(CAS), 국문]
function parseTable1(ws: XLSX.WorkSheet): Entry[] {
  const aoa: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const out: Entry[] = [];
  for (let i = 3; i < aoa.length; i++) {
    const r = aoa[i];
    const num = clean(r[0]);
    if (!/^\d/.test(num)) continue;
    const cn = clean(r[1]);
    const en = clean(r[2]);
    const kr = clean(r[3]);
    const inci = extractInciFromEnglish(en);
    if (!inci || inci.length < 2) continue;
    out.push({
      inci, korean: kr || null, chinese: cn || null, cas: extractCas(en), ci: null,
      status: "banned", max_concentration: null,
      conditions: `NMPA 화장품안전기술규범 표1 — 화장품 사용 금지 물질. 순번 ${num}.${kr ? ` 국문: ${kr}.` : ""}${cn ? ` 중문: ${cn}.` : ""}`,
      function_category: null,
    });
  }
  return out;
}

// 표2: row=4부터, [순번, 중문, 라틴학명, 국문]
function parseTable2(ws: XLSX.WorkSheet): Entry[] {
  const aoa: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const out: Entry[] = [];
  for (let i = 3; i < aoa.length; i++) {
    const r = aoa[i];
    const num = clean(r[0]);
    if (!/^\d/.test(num)) continue;
    const cn = clean(r[1]);
    const latin = clean(r[2]);
    const kr = clean(r[3]);
    const inci = latin.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!inci || inci.length < 2) continue;
    out.push({
      inci, korean: kr || null, chinese: cn || null, cas: null, ci: null,
      status: "banned", max_concentration: null,
      conditions: `NMPA 화장품안전기술규범 표2 — 화장품 사용 금지 식(동)물 물질. 순번 ${num}. 학명: ${latin}.${kr ? ` 국문: ${kr}.` : ""}`,
      function_category: null,
    });
  }
  return out;
}

// 표3-5,7 공통: row=5부터, header row 3-4 병합
//   표3: [순번, 중문, 영문, INCI, 국문, 적용범위, 농도, 기타]
//   표4-5: [순번, 중문, 영문, INCI, 국문, 농도, 사용범위, 라벨주의]
//   표7: [순번, 중문, (영문병합), INCI, (병합), 국문, 산화농도, 비산화농도, 기타]
function parseRestrictedOrListed(
  ws: XLSX.WorkSheet,
  status: "restricted" | "listed",
  function_category: string | null,
  tableLabel: string,
  layout: "table3" | "table4-5" | "table7",
): Entry[] {
  const aoa: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const out: Entry[] = [];
  let prev: Entry | null = null; // 직전 항목 — 순번 공백 연속행(2차 한도) 병합용
  for (let i = 4; i < aoa.length; i++) {
    const r = aoa[i];
    const num = clean(r[0]);
    let cn: string, en: string, inci: string, kr: string, cond_a: string, cond_b: string, cond_c: string;
    if (layout === "table3") {
      cn = clean(r[1]); en = clean(r[2]); inci = clean(r[3]); kr = clean(r[4]);
      cond_a = clean(r[5]); cond_b = clean(r[6]); cond_c = clean(r[7]);
    } else if (layout === "table4-5") {
      cn = clean(r[1]); en = clean(r[2]); inci = clean(r[3]); kr = clean(r[4]);
      cond_a = clean(r[5]); cond_b = clean(r[6]); cond_c = clean(r[7]);
    } else {
      // table7: 컬럼 위치 다름 (영문/INCI 병합으로 다음 col)
      cn = clean(r[1]); en = clean(r[2]) || clean(r[3]); inci = clean(r[3]); kr = clean(r[5]);
      cond_a = "산화염모제 " + (clean(r[6]) || "-");
      cond_b = "비산화염모제 " + (clean(r[7]) || "-");
      cond_c = clean(r[8]);
    }
    // 순번 공백 = 직전 항목의 연속(2차 적용범위·한도)행. 드롭 금지 → 직전 conditions 에 병합.
    // (예: Boric acid 의 (b)기타 제품·(c)별도 한도가 별행으로 와서 순번이 비어있음 → 35/82 누락이던 것.)
    if (!/^\d/.test(num)) {
      const extra = [cond_a, cond_b, cond_c].filter((x) => x && !/^(산화염모제|비산화염모제)\s*-?$/.test(x)).join(" / ");
      if (prev && extra) prev.conditions += `\n(추가 적용범위) ${extra}`;
      continue;
    }
    const inciOrEn = inci || extractInciFromEnglish(en);
    if (!inciOrEn || inciOrEn.length < 2) continue;
    const maxConc = parseAmount(cond_a) ?? parseAmount(cond_b);
    const conditions = [
      `NMPA 화장품안전기술규범 ${tableLabel} 등재. 순번 ${num}.`,
      kr ? `국문: ${kr}.` : null,
      cn ? `중문: ${cn}.` : null,
      cond_a ? `적용/농도: ${cond_a}` : null,
      cond_b ? `사용범위/주의: ${cond_b}` : null,
      cond_c ? `기타: ${cond_c}` : null,
    ].filter(Boolean).join("\n");
    const entry: Entry = {
      inci: inciOrEn, korean: kr || null, chinese: cn || null,
      cas: extractCas(en), ci: null, status, max_concentration: maxConc,
      conditions, function_category,
    };
    out.push(entry);
    prev = entry;
  }
  return out;
}

// 표6: row=5부터, [순번, CI번호, CI통용명, 색깔, CI중문, 적용범위×4]
function parseTable6(ws: XLSX.WorkSheet): Entry[] {
  const aoa: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const out: Entry[] = [];
  for (let i = 4; i < aoa.length; i++) {
    const r = aoa[i];
    const num = clean(r[0]);
    if (!/^\d/.test(num)) continue;
    const ci = clean(r[1]).replace(/\s*\(\d+\)\s*$/, ""); // "CI 10316 (2)" → "CI 10316"
    const ciName = clean(r[2]);
    const color = clean(r[3]);
    const cn = clean(r[4]);
    const ranges = [r[5], r[6], r[7], r[8]].map((x) => clean(x));
    if (!ci) continue;
    const conditions = [
      `NMPA 화장품안전기술규범 표6 — 화장품 준용 착색제. 순번 ${num}.`,
      `색깔: ${color}.`,
      ciName ? `통용명: ${ciName}.` : null,
      cn ? `중문: ${cn}.` : null,
      ranges.some(Boolean) ? `사용범위: ${["각종 화장품", "눈부위 제외 기타", "점막 비접촉 전용", "잠시 접촉 전용"].map((label, idx) => ranges[idx] ? `${label}(✓)` : null).filter(Boolean).join(", ")}` : null,
    ].filter(Boolean).join("\n");
    out.push({
      inci: ci, korean: null, chinese: cn || null, cas: null, ci, status: "listed",
      max_concentration: null, conditions, function_category: "색소",
    });
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  const path = XLSX_PATHS.find((p) => existsSync(p));
  if (!path) {
    console.error(`xlsx not found in any of: ${XLSX_PATHS.join(", ")}`);
    console.error("→ KCIA 14208 게시물에서 '화장품안전기술규범 원료(국문).xlsx' 다운로드 필요.");
    process.exit(1);
  }
  console.log(`▶ NMPA 안전기술규범 파싱: ${path}`);
  const buf = readFileSync(path);
  const wb = XLSX.read(buf);

  const sheets = {
    "표1.화장품 사용금지 물질": (ws: XLSX.WorkSheet) => parseTable1(ws),
    "표2.화장품 사용금지 식(동)물 물질": (ws: XLSX.WorkSheet) => parseTable2(ws),
    "표3.화장품 사용제한 물질": (ws: XLSX.WorkSheet) => parseRestrictedOrListed(ws, "restricted", null, "표3 — 사용제한 물질", "table3"),
    "표4.화장품 준용 방부제": (ws: XLSX.WorkSheet) => parseRestrictedOrListed(ws, "listed", "방부제", "표4 — 준용 방부제 (positive list)", "table4-5"),
    "표5.화장품 준용 자외선차단제": (ws: XLSX.WorkSheet) => parseRestrictedOrListed(ws, "listed", "자외선차단제", "표5 — 준용 자외선차단제 (positive list)", "table4-5"),
    "표6.화장품 준용 착색제": (ws: XLSX.WorkSheet) => parseTable6(ws),
    "표7.화장품 준용 염모제": (ws: XLSX.WorkSheet) => parseRestrictedOrListed(ws, "listed", "색소", "표7 — 준용 염모제 (positive list)", "table7"),
  };

  const allEntries: Entry[] = [];
  for (const [sheetName, parse] of Object.entries(sheets)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) {
      console.warn(`  시트 누락: ${sheetName}`);
      continue;
    }
    const entries = parse(ws);
    console.log(`  ${sheetName}: ${entries.length} entries`);
    allEntries.push(...entries);
  }
  console.log(`  총 ${allEntries.length} entries`);

  // ingredient 매칭/생성. 매칭 키 우선순위: INCI lower → CAS → korean.
  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInci = new Map<string, IngredientRow>();
  const byCas = new Map<string, IngredientRow>();
  const byKorean = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    byInci.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) byCas.set(i.cas_no, i);
    if (i.korean_name) byKorean.set(i.korean_name, i);
  }

  const now = new Date().toISOString();
  const sourceVersion = `KCIA-NMPA-2015-${now.slice(0, 10)}`;
  const newRegs: RegulationRow[] = [];
  let matched = 0, created = 0;

  for (const e of allEntries) {
    let ing = byInci.get(e.inci.toLowerCase());
    if (!ing && e.cas) ing = byCas.get(e.cas);
    if (!ing && e.korean) ing = byKorean.get(e.korean);
    if (!ing) {
      ing = {
        id: randomUUID(), inci_name: e.inci,
        korean_name: e.korean, chinese_name: e.chinese, japanese_name: null,
        cas_no: e.cas, synonyms: [], description: null,
        function_category: e.function_category, function_description: null,
      };
      ingredients.push(ing);
      byInci.set(e.inci.toLowerCase(), ing);
      if (e.cas) byCas.set(e.cas, ing);
      created++;
    } else {
      matched++;
      if (!ing.cas_no && e.cas) ing.cas_no = e.cas;
      if (!ing.chinese_name && e.chinese) ing.chinese_name = e.chinese;
      if (!ing.korean_name && e.korean) ing.korean_name = e.korean;
    }
    newRegs.push({
      ingredient_id: ing.id, country_code: "CN", status: e.status,
      max_concentration: e.max_concentration, concentration_unit: "%",
      product_categories: e.function_category ? [e.function_category] : [],
      conditions: e.conditions, source_url: SOURCE_URL, source_document: SOURCE_DOC,
      source_version: sourceVersion, source_priority: 100, last_verified_at: now,
      confidence_score: 1.0, override_note: null,
    });
  }
  console.log(`  matched ${matched}, new ingredients ${created}`);

  // 기존 동일 source 행 제거 후 새로 insert (idempotent)
  const existingRegs = await readRows<RegulationRow>("regulations");
  const otherSources = existingRegs.filter((r) => r.source_document !== SOURCE_DOC);
  const finalRegs = [...otherSources, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  CN NMPA 안전기술규범: ${newRegs.length} rows (priority 100)`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
