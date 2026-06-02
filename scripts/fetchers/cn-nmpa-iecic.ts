import { randomUUID } from "node:crypto";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";
import { launchContext } from "./playwright-helper";

// NMPA IECIC (已使用化妆品原料目录) 1차 소스 fetcher.
// curl 직접 시 body code:500 — Playwright 로 ysyhzpylmla 페이지 띄워 세션 받은 뒤
// queryYsyhzpylmlA API 호출. 매 실행 idempotent.
//
// IECIC = 중국 정부 등재 화장품 원료 positive list. 등재된 원료는 사용 가능,
// 미등재 원료는 신규 원료 신청(NCI) 필요. status='listed' 로 표기.

const SOURCE_DOC = "NMPA IECIC (已使用化妆品原料目录)";
const SOURCE_URL = "https://hzpsys.nifdc.org.cn/hzpGS/ysyhzpylml";
const API_URL = "https://hzpsys.nifdc.org.cn/hzpGS/queryYsyhzpylmlA";
const REFERER = "https://hzpsys.nifdc.org.cn/hzpGS/ysyhzpylmla";

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

interface IECICRow {
  XH: string;        // 序号 (serial number)
  ZWMC: string;      // 中文名称 (Chinese name)
  INCI: string;      // INCI 名称/英文名称
  BZ: string | null; // 备注 (remarks)
  ID: string;
  SFXTZ?: string;    // 是否系统调整
}

interface APIResponse {
  code: number;
  msg: string | null;
  data: { total: number; list: IECICRow[] };
}

function normInci(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/<[^>]+>/g, "").trim();
}

async function fetchAllPages(ctx: Awaited<ReturnType<typeof launchContext>>, pageSize = 100): Promise<IECICRow[]> {
  const all: IECICRow[] = [];
  // Bootstrap-table 의 진짜 파라미터: limit / offset / search / sort / order + queryParams 의 xh/zwmc/inci.
  // 페이지 띄워 첫 fetch 응답 가로채면 cookie/session/token 자동 처리됨.
  let total = -1;
  for (let offset = 0; total < 0 || offset < total; offset += pageSize) {
    const url = `${API_URL}?pageNumber=${Math.floor(offset / pageSize) + 1}&pageSize=${pageSize}&limit=${pageSize}&offset=${offset}&search=&sort=&order=&xh=&zwmc=&inci=`;
    const res = await ctx.fetchJson<APIResponse>(url, { referer: REFERER });
    if (Number(res.code) !== 2000) throw new Error(`API error code=${res.code} msg=${res.msg}`);
    if (!res.data) {
      console.error("unexpected response:", JSON.stringify(res).slice(0, 500));
      throw new Error("missing data");
    }
    const list = res.data.list ?? [];
    if (total < 0) total = Number(res.data.total) || 0;
    if (list.length === 0) break;
    all.push(...list);
    console.log(`  offset ${offset}: +${list.length} (total fetched ${all.length} / ${total})`);
    if (all.length >= total) break;
  }
  return all;
}

async function main() {
  const startedAt = Date.now();
  console.log(`▶ NMPA IECIC fetch (Playwright session)...`);
  const ctx = await launchContext({
    acceptLang: "zh-CN,zh;q=0.9",
    warmupUrl: REFERER,
  });

  let rows: IECICRow[];
  try {
    rows = await fetchAllPages(ctx);
  } finally {
    await ctx.close();
  }
  console.log(`  fetched ${rows.length} IECIC rows`);

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInciLower = new Map<string, IngredientRow>();
  for (const i of ingredients) byInciLower.set(i.inci_name.toLowerCase(), i);

  const newRegs: RegulationRow[] = [];
  const now = new Date().toISOString();
  const sourceVersion = `IECIC-${now.slice(0, 10)}`;

  let matched = 0, created = 0;
  for (const r of rows) {
    const inci = normInci(r.INCI);
    const zwmc = (r.ZWMC ?? "").trim();
    if (!inci) continue;

    let ing = byInciLower.get(inci.toLowerCase());
    if (!ing) {
      ing = {
        id: randomUUID(),
        inci_name: inci,
        korean_name: null,
        chinese_name: zwmc || null,
        japanese_name: null,
        cas_no: null,
        synonyms: [],
        description: null,
        function_category: null,
        function_description: null,
      };
      ingredients.push(ing);
      byInciLower.set(inci.toLowerCase(), ing);
      created++;
    } else {
      matched++;
      // 기존 ingredient 에 chinese_name 누락이면 IECIC 의 中文名称 채우기
      if (!ing.chinese_name && zwmc) ing.chinese_name = zwmc;
    }

    const conds = [
      `IECIC (已使用化妆品原料目录) 등재 — 중국 화장품에 사용 가능 (positive list).`,
      zwmc ? `중문명: ${zwmc}` : null,
      `序号 (序号): ${r.XH}`,
      r.BZ ? `비고 (备注): ${r.BZ.trim()}` : null,
    ].filter(Boolean).join("\n");

    newRegs.push({
      ingredient_id: ing.id,
      country_code: "CN",
      status: "listed",
      max_concentration: null,
      concentration_unit: "%",
      product_categories: [],
      conditions: conds,
      source_url: SOURCE_URL,
      source_document: SOURCE_DOC,
      source_version: sourceVersion,
      source_priority: 100,    // 1차 — 자국 정부 공식 DB
      last_verified_at: now,
      confidence_score: 1.0,
      override_note: null,
    });
  }
  console.log(`  ingredient matching: ${matched} matched, ${created} new`);

  // F15+ (정품검증): 파싱 0건이면(NMPA 사이트 IP 차단·구조변경 등) 기존 CN IECIC 8천여 행을
  // strip 후 빈 write 로 소실시키지 않고 보존. 다른 IP/환경에서도 자동으로 안전.
  if (newRegs.length === 0) {
    console.warn("  ! IECIC 파싱 0건 — 기존 regulations 보존 (write 생략)");
    return;
  }
  const existingRegs = await readRows<RegulationRow>("regulations");
  const otherSources = existingRegs.filter((r) => r.source_document !== SOURCE_DOC);
  const finalRegs = [...otherSources, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  IECIC rows: ${newRegs.length} (priority 100)`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
