import { randomUUID } from "node:crypto";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// US FDA — 21 CFR Part 700 (Federal Cosmetics Regulations) 1차 소스 fetcher.
// eCFR API 가 정형 XML 제공 (https://www.ecfr.gov/api/versioner/v1/full/{date}/title-21.xml?part=700).
// Part 700 의 ingredient-specific section 파싱 → regulations.json 머지 (source_priority=100).
//
// 매 실행 idempotent. 기존 source_document='US FDA 21 CFR 700' 행만 교체.

const SOURCE_DOC = "US FDA 21 CFR 700";
const SOURCE_URL = "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-G/part-700";

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

// Section → 적용할 INCI(s) + 한글 요약. 21 CFR 700 sections 가 적기 때문에 (9개)
// 명시적 hand-mapping 이 가장 정확. 각 section 의 "deemed adulterated" / "may not be used"
// 같은 표현이 banned, "permitted" / "shall not exceed" 가 restricted.
interface SectionMapping {
  section: string;          // "700.11"
  incis: string[];          // INCI 후보들 (ingredients.json 매칭용 lowercase)
  status: "banned" | "restricted";
  korean_summary: string;   // 한글 요약 (사용자에게 표시될 conditions)
  exceptions?: string;      // 예외 조항 한글 요약
}

const SECTIONS: SectionMapping[] = [
  {
    section: "700.11",
    incis: ["bithionol"],
    status: "banned",
    korean_summary: "Bithionol 함유 화장품은 21 CFR 700.11 에 따라 변질된(adulterated) 것으로 간주 — 광과민성 유발 우려.",
  },
  {
    section: "700.13",
    incis: ["mercury", "mercuric oxide", "mercury compounds", "phenylmercuric acetate", "phenylmercuric nitrate", "thimerosal"],
    status: "restricted",
    korean_summary: "수은 화합물 사용 금지. 단, 눈가 화장품(eye-area) 의 보존제로 phenylmercuric acetate / phenylmercuric nitrate 가 65 ppm 이하 (수은 기준) 일 경우 허용.",
    exceptions: "Eye-area cosmetics 보존제 한정 65 ppm Hg 이하.",
  },
  {
    section: "700.14",
    incis: ["vinyl chloride", "vinyl chloride monomer"],
    status: "banned",
    korean_summary: "Vinyl chloride 함유 화장품 에어로졸 제품 사용 금지 — 발암성.",
  },
  {
    section: "700.15",
    incis: ["halogenated salicylanilides", "tribromsalan", "dibromsalan", "metabromsalan", "tetrachlorosalicylanilide", "3,4',5-tribromosalicylanilide", "3,3',4,5'-tetrachlorosalicylanilide"],
    status: "banned",
    korean_summary: "특정 할로겐화 살리실아닐라이드 (TBS, dibromsalan, metabromsalan, TCSA, 3,4',5-TBS, 3,3',4,5'-TCSA) 함유 화장품 금지 — 광과민성 유발.",
  },
  {
    section: "700.16",
    incis: ["zirconium"],
    status: "banned",
    korean_summary: "지르코늄 함유 에어로졸 화장품 사용 금지 — 흡입 시 폐 육아종 형성 위험. (비-에어로졸 제품은 본 규정 적용 X)",
  },
  {
    section: "700.18",
    incis: ["chloroform"],
    status: "banned",
    korean_summary: "Chloroform 함유 화장품 금지 — 발암성. 단, 다른 ingredient 의 잔류 용매 (residual amount) 로 미량 존재하는 경우는 본 규정 적용 X.",
    exceptions: "잔류 용매 미량은 예외.",
  },
  {
    section: "700.19",
    incis: ["methylene chloride", "dichloromethane"],
    status: "banned",
    korean_summary: "Methylene chloride (= 디클로로메탄) 함유 화장품 금지 — 발암성.",
  },
  {
    section: "700.23",
    incis: ["chlorofluorocarbon", "trichlorofluoromethane", "dichlorodifluoromethane"],
    status: "banned",
    korean_summary: "오존층 파괴 chlorofluorocarbon (CFC) 추진제 사용 금지.",
  },
  {
    section: "700.27",
    incis: ["bovine spongiform encephalopathy", "cattle materials"],
    status: "banned",
    korean_summary: "광우병 (BSE) 위험 소(cattle) 유래 물질 사용 금지 — brain, spinal cord, eyes, tonsils, distal ileum 등 SRM (specified risk material).",
  },
];

interface CFRSection {
  number: string;
  title: string;
  body: string;
}

async function fetchEcfrXml(date: string): Promise<string> {
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-21.xml?part=700`;
  const res = await fetch(url, {
    headers: { "User-Agent": "cosmetics-reg/1.0 (auto data refresh)", Accept: "application/xml" },
  });
  if (!res.ok) {
    if (res.status === 404) {
      // 가장 최근 issue date 시도
      const titlesUrl = "https://www.ecfr.gov/api/versioner/v1/titles";
      const tRes = await fetch(titlesUrl, { headers: { Accept: "application/json" } });
      if (!tRes.ok) throw new Error(`Failed to fetch titles index: HTTP ${tRes.status}`);
      const tJson = await tRes.json() as { titles: { number: number; latest_issue_date: string }[] };
      const t21 = tJson.titles.find((t) => t.number === 21);
      if (!t21) throw new Error("Title 21 not found in eCFR index");
      console.log(`  retrying with latest_issue_date=${t21.latest_issue_date}`);
      return fetchEcfrXml(t21.latest_issue_date);
    }
    throw new Error(`eCFR fetch failed: HTTP ${res.status}`);
  }
  return res.text();
}

function parseSections(xml: string): Map<string, CFRSection> {
  const sections = new Map<string, CFRSection>();
  // <DIV8 N="700.X" TYPE="SECTION" ...> ... </DIV8>
  const re = /<DIV8\s+N="(700\.\d+)"\s+TYPE="SECTION"[^>]*>([\s\S]*?)<\/DIV8>/g;
  let m;
  while ((m = re.exec(xml))) {
    const number = m[1];
    const inner = m[2];
    const headMatch = inner.match(/<HEAD>([^<]+)<\/HEAD>/);
    const title = headMatch ? headMatch[1].replace(/&#xA7;/g, "§").trim() : "";
    // Strip XML tags from body, keep text
    const body = inner
      .replace(/<HEAD>[\s\S]*?<\/HEAD>/, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#xA7;/g, "§")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    sections.set(number, { number, title, body });
  }
  return sections;
}

function findOrCreateIngredient(
  ingredients: IngredientRow[],
  byInciLower: Map<string, IngredientRow>,
  inciCandidates: string[],
): { id: string; inci_name: string } | null {
  for (const cand of inciCandidates) {
    const ing = byInciLower.get(cand.toLowerCase());
    if (ing) return { id: ing.id, inci_name: ing.inci_name };
  }
  // 기존 매칭 실패 — 첫 candidate 로 신규 생성
  const newName = inciCandidates[0];
  const id = randomUUID();
  const created: IngredientRow = {
    id,
    inci_name: newName.replace(/\b\w/g, (c) => c.toUpperCase()),
    korean_name: null,
    chinese_name: null,
    japanese_name: null,
    cas_no: null,
    synonyms: inciCandidates.slice(1),
    description: null,
    function_category: null,
    function_description: null,
  };
  ingredients.push(created);
  byInciLower.set(newName.toLowerCase(), created);
  return { id, inci_name: created.inci_name };
}

async function main() {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  console.log(`▶ eCFR 21 CFR Part 700 fetch (date=${today})...`);
  const xml = await fetchEcfrXml(today);
  const sections = parseSections(xml);
  console.log(`  parsed ${sections.size} sections`);

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInciLower = new Map<string, IngredientRow>();
  for (const i of ingredients) byInciLower.set(i.inci_name.toLowerCase(), i);

  const newRegs: RegulationRow[] = [];
  const now = new Date().toISOString();
  // Source version derived from latest section's authority dates (fallback to today)
  const sourceVersion = `eCFR-${today}`;
  const matched: string[] = [];
  const created: string[] = [];

  for (const m of SECTIONS) {
    const sec = sections.get(m.section);
    if (!sec) {
      console.warn(`  ⊘ section ${m.section} not found in eCFR XML — skip`);
      continue;
    }
    // Find matching ingredient by INCI candidates
    for (const inci of m.incis) {
      const ing = findOrCreateIngredient(ingredients, byInciLower, [inci]);
      if (!ing) continue;

      const existed = byInciLower.get(inci.toLowerCase()) === ing && byInciLower.size > ingredients.length - 1;
      if (existed) matched.push(`${m.section}: ${ing.inci_name}`);
      else created.push(`${m.section}: ${ing.inci_name}`);

      const conditionsParts = [m.korean_summary];
      if (m.exceptions) conditionsParts.push(`예외: ${m.exceptions}`);
      conditionsParts.push(`원문 (${sec.title.trim()}):`);
      conditionsParts.push(sec.body.length > 800 ? sec.body.slice(0, 800) + "..." : sec.body);

      newRegs.push({
        ingredient_id: ing.id,
        country_code: "US",
        status: m.status,
        max_concentration: null,
        concentration_unit: "%",
        product_categories: [],
        conditions: conditionsParts.join("\n\n"),
        source_url: SOURCE_URL,
        source_document: SOURCE_DOC,
        source_version: sourceVersion,
        source_priority: 100,        // 1차 소스 — MFDS(50) 위로
        last_verified_at: now,
        confidence_score: 1.0,         // FDA 공식 규정문 → 최고 신뢰도
        override_note: null,
      });
    }
  }

  console.log(`  matched existing ingredients: ${matched.length}, created new: ${created.length}`);

  // F15+ (정품검증): 파싱 0건이면(eCFR 차단·구조변경) 기존 데이터 보존 — strip 후 빈 write 방지.
  if (newRegs.length === 0) {
    console.warn("  ! 파싱 0건 — 기존 regulations 보존 (write 생략)");
    return;
  }
  // 머지: 기존 source_document='US FDA 21 CFR 700' 행만 교체. 다른 source 보존.
  const existingRegs = await readRows<RegulationRow>("regulations");
  const otherSources = existingRegs.filter((r) => r.source_document !== SOURCE_DOC);
  const finalRegs = [...otherSources, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  US 21 CFR 700 regulations: ${newRegs.length} rows (priority 100)`);
  console.log(`  ingredients total: ${ingredients.length}, regulations total: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
