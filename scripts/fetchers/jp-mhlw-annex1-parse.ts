import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// JP MHLW 化粧品基準 別表 1 (jp_mhlw_annex_1.pdf, 105 page positive list).
// 카테고리 (1)~(11) × 성분 매트릭스. 각 cell 값: ○ = 무제한, 숫자 = 최대 농도, 빈칸 = 사용 불가.
// 코드: 1=일본약전, 31=JIS, 41=화장품원료기준, 42=종별배합성분규격, 72=식품첨가물, 73=타르색소.
//
// 132K text 정규식 직접. Gemini 0 dependency.
//
// 핵심 데이터 형식:
//   <ingredient name (multi-line)>\n
//   <code (1|31|41|42|72|73)>\n
//   <values: ○ or 0.5 or 5.0 ...>
// 또는:
//   <ingredient name (multi-line)>\n
//   <last name fragment> <code> <values...>

const SOURCE_DOC = "JP MHLW 化粧品基準 別表 1 (品目ごと承認対象成分 positive list)";
const SOURCE_URL = "https://www.mhlw.go.jp/content/001305716.pdf";
const PDF_PATH = ".crawl-raw/jp-mhlw/jp_mhlw_annex_1.pdf";

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

interface AnnexEntry {
  japanese_name: string;
  code: string;            // "1" | "31" | "41" | "42" | "72" | "73"
  cells: string[];         // ["○", "5.0", "", ...] up to 12 columns
  max_concentration: number | null;
  allowed_categories: number;  // count of non-empty cells
}

const CATEGORY_NAMES = [
  "(1)清浄用 cleansing",
  "(2)頭髪用 hair",
  "(3)基礎 basic",
  "(4)メークアップ makeup",
  "(5)芳香 fragrance",
  "(6)日焼け sun",
  "(7)爪 nail",
  "(8)アイライナー eyeliner",
  "(9)口唇 lip",
  "(10)口腔 oral",
  "(11)入浴 bath",
  "その他 other",
];

const CODE_DESCRIPTIONS: Record<string, string> = {
  "1": "일본약국방 (JP Pharmacopoeia)",
  "31": "JIS — 일본공업규격",
  "41": "화장품원료기준 (1967, 厚生省 告示 322)",
  "42": "種別配합성분규격 (별표 별기)",
  "72": "식품첨가물 공정서 (식품위생법 13조)",
  "73": "타르색소 (1966 厚生省令 30, 別表 1/2/3)",
};

// 페이지 헤더로 인식되는 fixed 줄 (skip 대상). 매 페이지 반복됨.
const PAGE_HEADER_LINES = new Set([
  "成分名 コード (1)清浄用",
  "成分名", "コード",
  "(1)清浄用", "化粧品",
  "(2)頭髪用",
  "(3)基礎化", "粧品",
  "(4)メーク", "アップ化",
  "(5)芳香化",
  "(6)日焼", "け・日焼", "け止め化",
  "(7)爪化粧", "品",
  "(8)アイラ", "イナー化",
  "(9)口唇化",
  "（10）口", "腔化粧品",
  "（11）入", "浴用化粧",
  "その他",
]);

function isPageHeaderLine(line: string): boolean {
  if (PAGE_HEADER_LINES.has(line)) return true;
  if (/^-- \d+ of \d+ --$/.test(line)) return true;
  if (/^最終改正：/.test(line)) return true;
  if (/^別表$/.test(line)) return true;
  if (/^昭和三十六年/.test(line)) return true;
  if (/^は以下のとおり。$/.test(line)) return true;
  return false;
}

function parseValueCells(remainder: string): { cells: string[]; max: number | null; allowed: number } {
  // 셀 토큰: ○ 또는 숫자 (소수점 포함). split by whitespace.
  const tokens = remainder.trim().split(/\s+/).filter(Boolean);
  const cells: string[] = [];
  let max: number | null = null;
  let allowed = 0;
  for (const tok of tokens) {
    if (tok === "○") {
      cells.push("○");
      allowed++;
    } else if (/^\d+(\.\d+)?$/.test(tok)) {
      cells.push(tok);
      const n = Number(tok);
      if (max === null || n > max) max = n;
      allowed++;
    } else {
      // unknown token — skip
    }
  }
  return { cells, max, allowed };
}

function parseAnnex1(text: string): AnnexEntry[] {
  // 마지막 페이지 "（注意）" 이후는 description — 절단.
  const cutIdx = text.indexOf("（注意）");
  const body = cutIdx > 0 ? text.slice(0, cutIdx) : text;
  const lines = body.split(/\r?\n/);
  const out: AnnexEntry[] = [];
  let nameBuf: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (isPageHeaderLine(raw)) continue;

    // case A: 라인 내부에 code + values — "<name fragment> CODE val val val..."
    const inlineM = raw.match(/^(.+?)\s+(1|31|41|42|72|73)\s+([○\d. ]+)$/);
    if (inlineM) {
      nameBuf.push(inlineM[1]);
      const fullName = nameBuf.join("").replace(/\s+/g, "");
      const { cells, max, allowed } = parseValueCells(inlineM[3]);
      if (fullName.length >= 2 && cells.length > 0) {
        out.push({ japanese_name: fullName, code: inlineM[2], cells, max_concentration: max, allowed_categories: allowed });
      }
      nameBuf = [];
      continue;
    }
    // case B: 라인이 단독 code (다음 line 이 values)
    const standaloneCode = raw.match(/^(1|31|41|42|72|73)$/);
    if (standaloneCode) {
      // 다음 줄 = values
      let valuesLine = "";
      while (++i < lines.length) {
        const next = lines[i].trim();
        if (!next) continue;
        if (isPageHeaderLine(next)) continue;
        valuesLine = next;
        break;
      }
      const fullName = nameBuf.join("").replace(/\s+/g, "");
      const { cells, max, allowed } = parseValueCells(valuesLine);
      if (fullName.length >= 2 && cells.length > 0) {
        out.push({ japanese_name: fullName, code: standaloneCode[1], cells, max_concentration: max, allowed_categories: allowed });
      }
      nameBuf = [];
      continue;
    }
    // case C: code + values 가 같은 라인에 있는데 위 inlineM regex 가 못 잡은 경우 (이름 비어있음)
    const codeOnlyValues = raw.match(/^(1|31|41|42|72|73)\s+([○\d. ]+)$/);
    if (codeOnlyValues) {
      const fullName = nameBuf.join("").replace(/\s+/g, "");
      const { cells, max, allowed } = parseValueCells(codeOnlyValues[2]);
      if (fullName.length >= 2 && cells.length > 0) {
        out.push({ japanese_name: fullName, code: codeOnlyValues[1], cells, max_concentration: max, allowed_categories: allowed });
      }
      nameBuf = [];
      continue;
    }
    // 그 외 → ingredient name 누적
    nameBuf.push(raw);
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log(`▶ JP MHLW 別表 1 PDF 파싱 (${PDF_PATH})...`);
  const buf = readFileSync(PDF_PATH);
  const { PDFParse } = await import("pdf-parse");
  const r = await new PDFParse({ data: buf }).getText();
  console.log(`  text length: ${r.text.length}`);

  const entries = parseAnnex1(r.text);
  console.log(`  parsed entries: ${entries.length}`);
  if (entries.length < 100) {
    console.warn(`  ! 너무 적음 — abort`);
    return;
  }

  const ingredients = await readRows<IngredientRow>("ingredients");
  // 매칭 — japanese_name, inci_name 둘 다.
  const byJp = new Map<string, IngredientRow>();
  const byInci = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    if (i.japanese_name) byJp.set(i.japanese_name.replace(/\s+/g, ""), i);
    byInci.set(i.inci_name.toLowerCase(), i);
  }

  const now = new Date().toISOString();
  const newRegs: RegulationRow[] = [];
  let matched = 0, created = 0;
  const skipped = 0;

  for (const e of entries) {
    let ing = byJp.get(e.japanese_name);
    if (!ing) ing = byInci.get(e.japanese_name.toLowerCase());
    if (!ing) {
      // 신규 — japanese_name 만 보유. inci_name 임시로 japanese_name 사용 (manual enrich 가 보강).
      ing = {
        id: randomUUID(),
        inci_name: e.japanese_name,
        korean_name: null,
        chinese_name: null,
        japanese_name: e.japanese_name,
        cas_no: null,
        synonyms: [],
        description: null,
        function_category: null,
        function_description: null,
      };
      ingredients.push(ing);
      byJp.set(e.japanese_name, ing);
      byInci.set(e.japanese_name.toLowerCase(), ing);
      created++;
    } else {
      // japanese_name 비어있으면 채움
      if (!ing.japanese_name) ing.japanese_name = e.japanese_name;
      matched++;
    }

    // status 결정: 모든 cell ○ → "listed", 어떤 cell 에 숫자 → "restricted".
    const hasNumeric = e.cells.some((c) => c !== "○");
    const status = hasNumeric ? "restricted" : "listed";

    const cellSummary = e.cells
      .map((c, idx) => `${CATEGORY_NAMES[idx] ?? `col${idx}`}: ${c === "○" ? "허용" : c === "" ? "불가" : c + "%"}`)
      .filter((s) => !s.endsWith("불가"))
      .slice(0, 6)
      .join(" / ");

    const conditionsText = [
      `JP MHLW 化粧品基準 別表 1 (품목별 承認対象成分 positive list) 등재.`,
      `코드 ${e.code}: ${CODE_DESCRIPTIONS[e.code] ?? "기타"}.`,
      `사용 가능 카테고리: ${e.allowed_categories}/12 (${cellSummary}${e.allowed_categories > 6 ? " ..." : ""}).`,
      e.max_concentration !== null ? `최대 농도: ${e.max_concentration}%.` : null,
    ].filter(Boolean).join("\n");

    newRegs.push({
      ingredient_id: ing.id,
      country_code: "JP",
      status,
      max_concentration: e.max_concentration,
      concentration_unit: "%",
      product_categories: [],
      conditions: conditionsText,
      source_url: SOURCE_URL,
      source_document: SOURCE_DOC,
      source_version: `MHLW-別表1-${now.slice(0, 10)}`,
      source_priority: 100,
      last_verified_at: now,
      confidence_score: 1.0,
      override_note: null,
    });
  }

  console.log(`  matched ${matched}, created ${created}, skipped ${skipped}`);

  const existingRegs = await readRows<RegulationRow>("regulations");
  // 이전 run 의 다른 suffix variant 도 함께 제거.
  const filteredRegs = existingRegs.filter((r) => !r.source_document.startsWith("JP MHLW 化粧品基準 別表 1"));
  const finalRegs = [...filteredRegs, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  JP 別表 1: ${newRegs.length} regulations (priority 100)`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
