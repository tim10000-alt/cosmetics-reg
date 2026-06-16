import "./pdf-polyfill";   // 환경 독립 — pdf-parse 가 구버전 Node 에서도 동작 (pdf-parse import 전 필수)
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";
import { geminiRescue, buildRegsFromExtracted } from "../parsers/gemini-fallback";

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
  cells: string[];         // 12 컬럼 정확히 — ["○", "5.0", "", ...]. ""=사용 금지(blank), "○"=제한없음, 숫자=최대%
  max_concentration: number | null;
  allowed_categories: number;  // count of non-blank cells (사용 가능 제품군 수)
  footnote: string;        // 각주(집계·환산·특례 규정) — 12번째 셀/추가 컬럼에서 추출
}

// 제품군(제형) 한글명 — 별표1 12개 카테고리 고정 구조. 사용자 직관(씻어내는/씻지않는 등) 위해 한글.
const CATEGORY_NAMES = [
  "세정용(씻어내는 제품)",
  "두발용",
  "기초화장품(스킨케어)",
  "메이크업",
  "방향용(향수)",
  "선케어·자외선차단",
  "손발톱(네일)",
  "아이라이너",
  "입술",
  "구강용",
  "입욕용",
  "기타",
];

// 각주 보일러플레이트 결정론 한글화 — 별표1 각주는 집계·환산·특례 규정의 정형구. 성분명(고유)은
// 보존하고 문법 골격만 한글화(무Gemini·무인·결정론). 양식 신설 footnote 는 골격만 부분 한글화돼도
// 의미 전달(자외선합계·치약특례·IU 정의 등 핵심구는 완역). translateDisplay 는 한글우세 텍스트를
// 안 건드리므로 여기서 결정론 한글화가 정확·안정.
function footnoteKo(s: string): string {
  let t = (s || "").trim();
  if (!t) return t;
  t = t.replace(/紫外線吸収剤の合計は\s*10\s*以下とする。?/g, "자외선흡수제 합계는 10% 이하로 한다.");
  t = t.replace(/ＩＵは[、,]?\s*100ｇに対して配合する当該成分の国際単位を表す。?/g, "IU는 100g당 배합하는 해당 성분의 국제단위(IU)를 나타낸다.");
  t = t.replace(/Ｕは[、,]?\s*100ｇに対して配合する当該成分の力価を表す。?/g, "U는 100g당 배합하는 해당 성분의 역가를 나타낸다.");
  t = t.replace(/歯磨きの目的で使用されるもので薄める用法のものは０．60と?し、かつ使用時０．10以下となる?こと。?/g, "치약 목적으로 사용되어 희석하는 용법은 0.60%로 하고, 사용 시 0.10% 이하가 되어야 한다.");
  t = t.replace(/すべての|すベての/g, "모든 ");
  t = t.replace(/誘導体を/g, " 유도체를 ");
  t = t.replace(/に換算して[、,]?/g, "(으)로 환산하여 ");
  t = t.replace(/及びその塩類並びに/g, " 및 그 염류와 ");
  t = t.replace(/及びその塩類/g, " 및 그 염류");
  t = t.replace(/及びその誘導体/g, " 및 그 유도체");
  t = t.replace(/及びそのエステル/g, " 및 그 에스테르");
  t = t.replace(/として合計。?/g, "(으)로서 합계. ");
  t = t.replace(/として。/g, "(으)로서 산정. ");
  t = t.replace(/及び/g, " 및 ");
  t = t.replace(/コード/g, "코드");
  t = t.replace(/（/g, "(").replace(/）/g, ")");
  t = t.replace(/\s{2,}/g, " ").trim();
  t = t.replace(/\.\s*$/, ".");
  return t;
}
// 셀이 값(○/숫자/blank)이 아니라 각주 텍스트인지 — 12번째 컬럼에 각주가 병합되는 케이스 탐지.
const isFootnoteCell = (c: string): boolean =>
  /[。]|として|に換算|以下とする|当該成分|国際単位|力価|歯磨き/.test(c) || (/[ぁ-んァ-ヶ一-龠]/.test(c) && c.length >= 6);

const CODE_DESCRIPTIONS: Record<string, string> = {
  "1": "일본약국방(일본약전, JP Pharmacopoeia)",
  "31": "JIS 일본공업규격",
  "41": "화장품원료기준 (1967, 후생성 고시 제322호)",
  "42": "종별 배합성분 규격 (별표 별기)",
  "72": "식품첨가물 공정서 (식품위생법 제13조)",
  "73": "타르색소 (1966, 후생성령 제30호, 별표 1/2/3)",
};

// getTable() 표 추출 결과(페이지×표×행, 각 행=셀 배열)에서 성분 행만 골라 구조화.
// 셀 0=성분명, 1=코드, 2~13=12개 제품군(○/숫자/blank). 14+=각주(가끔 12번째 셀에 병합).
// 이 방식은 PDF 텍스트 추출 *순서 교란*에 영향받지 않아(표 셀 단위 복원) garble 0 + 빈칸(금지)
// 위치를 정확히 보존 → 정확한 제형별 한도·금지 표기 가능. 전 결정론·무Gemini.
function parseAnnex1FromTable(table: { pages: Array<{ tables: string[][][] }> }): AnnexEntry[] {
  const CODES = new Set(["1", "31", "41", "42", "72", "73"]);
  const out: AnnexEntry[] = [];
  for (const pg of table.pages || []) {
    for (const tbl of pg.tables || []) {
      for (const row0 of tbl) {
        const row = row0.map((c) => (c || "").replace(/\n/g, "").trim());
        // 성분 행: 셀1=코드, 셀0=성분명(있음), 헤더행 제외.
        if (row.length < 13 || !CODES.has(row[1]) || !row[0] || /成分名/.test(row[0])) continue;
        const name = row[0];
        if (name.length < 2) continue;
        const code = row[1];
        const cells = row.slice(2, 14);                  // 12개 제품군 셀
        while (cells.length < 12) cells.push("");         // 누락 컬럼은 blank(금지)로
        // 각주 추출 — 12번째 셀(기타)에 각주가 병합되거나 14열 이후에 잔여.
        let footnote = "";
        if (cells[11] && isFootnoteCell(cells[11])) { footnote = cells[11]; cells[11] = ""; }
        if (row.length > 14) { const extra = row.slice(14).filter(Boolean).join(" "); if (extra) footnote = (footnote ? footnote + " " : "") + extra; }
        // 정규화: ○/숫자만 유효 셀, 그 외(각주잔재 등)는 blank 처리.
        let max: number | null = null, allowed = 0;
        for (let i = 0; i < 12; i++) {
          const c = (cells[i] || "").trim();
          if (c === "○") { allowed++; }
          else if (/^\d+(\.\d+)?$/.test(c)) { allowed++; const n = Number(c); if (max === null || n > max) max = n; }
          else { cells[i] = ""; }                          // blank = 사용 금지
        }
        out.push({ japanese_name: name.replace(/\s+/g, ""), code, cells, max_concentration: max, allowed_categories: allowed, footnote });
      }
    }
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log(`▶ JP MHLW 別表 1 PDF 파싱 (${PDF_PATH})...`);
  const buf = readFileSync(PDF_PATH);
  const { PDFParse } = await import("pdf-parse");
  // getTable() — 표 셀 단위 복원(텍스트 순서 교란 무관) → garble 0 + 빈칸(금지) 위치 정확 보존.
  const table = await new PDFParse({ data: buf }).getTable();
  console.log(`  table pages: ${(table.pages || []).length}`);

  const entries = parseAnnex1FromTable(table as { pages: Array<{ tables: string[][][] }> });
  console.log(`  parsed entries: ${entries.length}`);

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

  if (entries.length < 100) {
    // 정규식 0/소수(<100) = 別表1 PDF 양식 변경 신호 → Gemini 폴백 1회(무료 throttle).
    // 정상(≥100)이면 이 분기 미실행 → 기존 루프와 100% 동일(부작용 0).
    const rescued = await geminiRescue({ filePath: PDF_PATH, country: "JP", title: SOURCE_DOC, url: SOURCE_URL });
    if (rescued.length === 0) {
      console.warn(`  ! entries ${entries.length}<100 이고 Gemini 폴백도 0건 — abort(기존 데이터 보존)`);
      return;
    }
    newRegs.push(...buildRegsFromExtracted({ regs: rescued, ingredients, country: "JP", sourceDoc: SOURCE_DOC, sourceUrl: SOURCE_URL, now }));
    console.log(`  ⚠ 정규식 ${entries.length}건(<100) → Gemini 폴백 ${newRegs.length}건 확보 (confidence 0.75)`);
  } else {
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

    // status 결정: 모든 12개 제품군이 ○(제한없음) → "listed", 일부라도 숫자(농도제한) 또는
    // blank(금지) → "restricted"(제형별 제한 존재). 빈칸=금지를 status 에 반영(사용자 안전).
    const hasLimitOrBan = e.cells.some((c) => c !== "○");
    const status = hasLimitOrBan ? "restricted" : "listed";

    // 제형별(제품군) 한도 — 12개 제품군 각각 한글명 + 한도/금지를 *전부* 표기(사용자 직접 요청:
    // "씻어내는/씻지않는/유아용 등 제형별로 함량 제한·금지 따로 표기"). ConditionBlocks 가
    // <…> 헤더·∙ 불릿·[비고] 경고블록으로 렌더 → KR(MFDS) 수준 가독성. 같은 한도끼리 묶어 압축.
    const fmtCell = (c: string): string => (c === "○" ? "제한 없음" : /^\d/.test(c) ? `${c}%` : "사용 금지");
    const groups = new Map<string, string[]>();
    for (let i = 0; i < 12; i++) { const v = fmtCell((e.cells[i] || "").trim()); if (!groups.has(v)) groups.set(v, []); groups.get(v)!.push(CATEGORY_NAMES[i]); }
    // 표기 순서: 허용/한도 먼저, 금지 마지막. 한 한도가 모든 제품군이면 단일 줄.
    const order = (v: string) => (v === "사용 금지" ? 2 : v === "제한 없음" ? 0 : 1);
    const catLines = [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]))
      .map(([v, cats]) => cats.length === 12 ? `∙ 전 제품군: ${v}` : `∙ ${cats.join(", ")}: ${v}`);
    const conditionsText = [
      `JP MHLW 化粧品基準 別表1 (품목별 승인대상 성분 positive list) 등재.`,
      `근거: 코드 ${e.code} — ${CODE_DESCRIPTIONS[e.code] ?? "기타"}.`,
      ``,
      `<제형별(제품군) 배합한도 — 12개 제품군>`,
      ...catLines,
      e.footnote ? `` : null,
      e.footnote ? `[비고] ${footnoteKo(e.footnote)}` : null,
    ].filter((l) => l !== null).join("\n");

    // 적용 제품(헤드라인 칩) — 허용/한도 제품군 한글명(금지 제외). 전 제품군 허용이면 "전 제품군".
    const allowedCats = e.cells.map((c, i) => ((c || "").trim() !== "" ? CATEGORY_NAMES[i] : null)).filter(Boolean) as string[];
    const productCategories = allowedCats.length === 12 ? ["전 제품군"] : allowedCats;

    newRegs.push({
      ingredient_id: ing.id,
      country_code: "JP",
      status,
      max_concentration: e.max_concentration,
      concentration_unit: "%",
      product_categories: productCategories,
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
  }

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
