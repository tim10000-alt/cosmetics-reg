import { randomUUID } from "node:crypto";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// CN IECIC 2025 한국어 번역본 (KCIA 16818) — 「기사용화장품원료목록」I 별표 xlsx.
// 출처: NMPA 2025년 제61호 공고 (2025-04-13 update), KCIA 16818 첨부.
// 8987 ingredient × (순번, 中文명칭, INCI/영문명칭) 표.
//
// 목적:
//   1) 기존 ingredient 의 chinese_name 채우기 (cn-nmpa-iecic.ts 가 INCI 만 가져옴).
//   2) 기존 IECIC 미커버 신규 항목은 ingredient + CN regulation 추가 (priority 100).
//
// 기존 cn-nmpa-iecic.ts (Playwright API) 와 coexist — 다른 source_document 사용.

const XLSX_PATH = "public/data/raw-attach/kcia-16818/별표1.「기사용화장품원료목록」Ⅰ(국문).xlsx";
const SOURCE_DOC = "NMPA 已使用化妆品原料目录 (IECIC 2025-04-13, KCIA 16818 한국어 번역본)";
const SOURCE_URL = "https://kcia.or.kr/home/law/law_05.php?type=view&no=16818";

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

interface IecicEntry {
  ord: number;
  chinese: string;
  inci: string;
  notes: string;
}

async function parseXlsx(): Promise<IecicEntry[]> {
  // tsx ESM 환경에서 XLSX.readFile 미노출 — default import + read(buffer) 사용.
  const XLSX = (await import("xlsx")).default;
  const fs = await import("node:fs");
  const buf = fs.readFileSync(XLSX_PATH);
  const wb = XLSX.read(buf);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", blankrows: false });
  const out: IecicEntry[] = [];
  // header rows: 0=별첨1, 1=목록 title, 2=설명, 3=column header (순번/중문명칭/INCI/비고)
  for (let i = 4; i < rows.length; i++) {
    const r = rows[i];
    const ord = Number(r[0]);
    const chinese = String(r[1] ?? "").trim();
    const inci = String(r[2] ?? "").trim();
    const notes = String(r[3] ?? "").trim();
    if (!ord || !chinese || !inci) continue;
    if (ord < 1 || ord > 99999) continue;
    out.push({ ord, chinese, inci, notes });
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log(`▶ CN IECIC 2025 xlsx 파싱 (${XLSX_PATH})`);
  // 첨부 xlsx(KCIA 16818)가 다운로드 안 됐으면 *graceful skip* — 이건 CN IECIC 의 *한국어 번역 보조*
  // 소스다. CN 본체 IECIC(cn-nmpa-iecic, ~8,900행)는 별도로 정상 인입되므로 누락돼도 CN 데이터 보존.
  // 기존엔 ENOENT 로 throw→exit(1) 해서 매 crawl 에러스팸 + 첨부 미존재(KCIA 게시물 회전)에 취약했다.
  const fsmod = await import("node:fs");
  if (!fsmod.existsSync(XLSX_PATH)) {
    console.warn(`  ⚠ 첨부 xlsx 없음 — CN IECIC 한국어 번역보조 skip(CN 본체는 cn-nmpa-iecic 가 인입). 보존.`);
    return;
  }
  const entries = await parseXlsx();
  console.log(`  parsed ${entries.length} entries`);

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInci = new Map<string, IngredientRow>();
  const byChinese = new Map<string, IngredientRow>();
  for (const ing of ingredients) {
    if (ing.inci_name) byInci.set(ing.inci_name.toLowerCase(), ing);
    if (ing.chinese_name) byChinese.set(ing.chinese_name, ing);
  }

  const now = new Date().toISOString();
  let enriched = 0, created = 0, alreadyOk = 0;
  const newRegs: RegulationRow[] = [];

  for (const e of entries) {
    let ing = byInci.get(e.inci.toLowerCase());
    if (!ing) ing = byChinese.get(e.chinese);
    if (ing) {
      if (!ing.chinese_name) {
        ing.chinese_name = e.chinese;
        byChinese.set(e.chinese, ing);
        enriched++;
      } else if (ing.chinese_name === e.chinese) {
        alreadyOk++;
      }
      // 신규 regulation 미발급 — 기존 cn-nmpa-iecic.ts (Playwright API) 가 이미 emit.
      continue;
    }
    // 신규 ingredient
    ing = {
      id: randomUUID(),
      inci_name: e.inci,
      korean_name: null,
      chinese_name: e.chinese,
      japanese_name: null,
      cas_no: null,
      synonyms: [],
      description: null,
      function_category: null,
      function_description: null,
    };
    ingredients.push(ing);
    byInci.set(e.inci.toLowerCase(), ing);
    byChinese.set(e.chinese, ing);
    created++;

    newRegs.push({
      ingredient_id: ing.id,
      country_code: "CN",
      status: "listed",
      max_concentration: null,
      concentration_unit: "%",
      product_categories: [],
      conditions: [
        `NMPA 「已使用化妆品原料目录」I (IECIC 2025-04-13 update) 등재.`,
        `중문명칭: ${e.chinese}`,
        `순번: ${e.ord}`,
        e.notes ? `비고: ${e.notes}` : null,
        `출처: KCIA 16818 첨부 별표 1 (한국어 번역본).`,
      ].filter(Boolean).join("\n"),
      source_url: SOURCE_URL,
      source_document: SOURCE_DOC,
      source_version: "IECIC-2025-04-13",
      source_priority: 100,
      last_verified_at: now,
      confidence_score: 1.0,
      override_note: null,
    });
  }

  console.log(`  enriched chinese_name: ${enriched}`);
  console.log(`  already OK: ${alreadyOk}`);
  console.log(`  new ingredients + CN regs: ${created}`);

  const existingRegs = await readRows<RegulationRow>("regulations");
  const filteredRegs = existingRegs.filter((r) => r.source_document !== SOURCE_DOC);
  const finalRegs = [...filteredRegs, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  IECIC 2025 entries: ${entries.length}`);
  console.log(`  chinese_name 보강: ${enriched}, 신규 ingredient: ${created}`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
