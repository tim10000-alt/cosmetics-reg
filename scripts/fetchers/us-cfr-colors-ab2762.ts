import { randomUUID } from "node:crypto";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// US 확장 1차 출처 fetcher.
// 1) 21 CFR Part 73 Subpart C — Cosmetics 색소 (인증면제 positive list)
// 2) 21 CFR Part 74 Subpart C — Cosmetics 색소 (인증요구 positive list)
// 3) California AB 2762 (Toxic-Free Cosmetics Act 2020, 2025-01-01 발효) — 24 ban
//
// eCFR API 정형 XML 사용. priority 100 (1차 emerald).
// us-ecfr.ts 가 Part 700 (banned/restricted) 처리, 이 파일이 색소 + state 법.

const PART73_DOC = "US FDA 21 CFR 73 Subpart C — Cosmetics 색소 (인증면제 positive list)";
const PART74_DOC = "US FDA 21 CFR 74 Subpart C — Cosmetics 색소 (인증요구 positive list)";
const AB2762_DOC = "California AB 2762 — Toxic-Free Cosmetics Act 2020 (2025-01-01 발효)";
const PART73_URL = "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-73/subpart-C";
const PART74_URL = "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-74/subpart-C";
const AB2762_URL = "https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=201920200AB2762";

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

interface ColorEntry {
  section: string;            // "73.2030"
  inci: string;               // "Annatto"
  conditions_text: string;    // section body trimmed
}

async function fetchEcfrXml(part: number, date: string): Promise<string> {
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-21.xml?part=${part}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "cosmetics-reg/1.0", Accept: "application/xml" },
  });
  if (!res.ok) {
    if (res.status === 404) {
      const tRes = await fetch("https://www.ecfr.gov/api/versioner/v1/titles", { headers: { Accept: "application/json" } });
      const tJson = await tRes.json() as { titles: { number: number; latest_issue_date: string }[] };
      const t21 = tJson.titles.find((t) => t.number === 21);
      if (!t21) throw new Error("Title 21 not found");
      console.log(`  Part ${part} — retry with ${t21.latest_issue_date}`);
      return fetchEcfrXml(part, t21.latest_issue_date);
    }
    throw new Error(`eCFR Part ${part} fetch failed: HTTP ${res.status}`);
  }
  return res.text();
}

// Subpart C 만 추출. <DIV6 N="C" TYPE="SUBPART"> ... </DIV6> 사이의 DIV8 sections.
function extractSubpartC(xml: string, part: number): ColorEntry[] {
  const subpartM = xml.match(/<DIV6\s+N="C"\s+TYPE="SUBPART"[^>]*>([\s\S]*?)(?=<DIV6\s+N="[D-Z]"|<\/DIV5>)/);
  if (!subpartM) {
    console.warn(`  Part ${part} — Subpart C not found`);
    return [];
  }
  const subpartXml = subpartM[1];
  const out: ColorEntry[] = [];
  const re = /<DIV8\s+N="(\d+\.\d+\w*)"\s+TYPE="SECTION"[^>]*>([\s\S]*?)<\/DIV8>/g;
  let m;
  while ((m = re.exec(subpartXml))) {
    const section = m[1];
    const inner = m[2];
    const headM = inner.match(/<HEAD>([^<]+)<\/HEAD>/);
    if (!headM) continue;
    // HEAD 형식: "§ 73.2030 Annatto." — section + 색소명 + 마침표
    // 이름에도 HTML 엔티티 전체 디코드(이전엔 &#xA7; 만 → "D&amp;C", "&#x3B2;-Carotene" 깨짐).
    const head = headM[1]
      .replace(/&#xA7;/g, "§")
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
      .replace(/&amp;/g, "&")
      .trim();
    // "§ 73.2030 Annatto." → "Annatto"
    const inciM = head.match(/§\s*\d+\.\d+\w*\s+(.+?)\.?\s*$/);
    if (!inciM) continue;
    const inci = inciM[1].trim();
    if (!inci || inci.length < 2 || inci.length > 200) continue;
    // 본문 추출
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
    out.push({
      section,
      inci,
      conditions_text: body.length > 800 ? body.slice(0, 800) + "..." : body,
    });
  }
  return out;
}

// California AB 2762 (Toxic-Free Cosmetics Act, 2020) — 24 substances banned 2025-01-01.
// 출처: leginfo.legislature.ca.gov 본문 + CDPH FAQ.
// dibutyl phthalate, diethylhexyl phthalate, formaldehyde, paraformaldehyde,
// methylene glycol, quaternium-15, mercury, isobutylparaben, isopropylparaben,
// m-phenylenediamine + salts, o-phenylenediamine + salts,
// 그리고 13개 PFAS substances:
//   PFOA, PFOS, PFNA, PFHxS, PFDA, PFHxA, PFHpA,
//   PFBS, HFPO-DA (GenX), PFPeA, PFBA, PFOSA, PFDoA
const AB2762_BANS: { inci: string; cas: string | null; aka: string[] }[] = [
  { inci: "Dibutyl phthalate", cas: "84-74-2", aka: ["DBP"] },
  { inci: "Diethylhexyl phthalate", cas: "117-81-7", aka: ["DEHP"] },
  { inci: "Formaldehyde", cas: "50-00-0", aka: [] },
  { inci: "Paraformaldehyde", cas: "30525-89-4", aka: [] },
  { inci: "Methylene glycol", cas: "463-57-0", aka: ["Formaldehyde hydrate"] },
  { inci: "Quaternium-15", cas: "4080-31-3", aka: [] },
  { inci: "Mercury", cas: "7439-97-6", aka: [] },
  { inci: "Isobutylparaben", cas: "4247-02-3", aka: [] },
  { inci: "Isopropylparaben", cas: "4191-73-5", aka: [] },
  { inci: "m-Phenylenediamine and its salts", cas: "108-45-2", aka: ["m-Phenylenediamine"] },
  { inci: "o-Phenylenediamine and its salts", cas: "95-54-5", aka: ["o-Phenylenediamine"] },
  // PFAS 13종
  { inci: "Perfluorooctanoic acid (PFOA)", cas: "335-67-1", aka: ["PFOA"] },
  { inci: "Perfluorooctanesulfonic acid (PFOS)", cas: "1763-23-1", aka: ["PFOS"] },
  { inci: "Perfluorononanoic acid (PFNA)", cas: "375-95-1", aka: ["PFNA"] },
  { inci: "Perfluorohexanesulfonic acid (PFHxS)", cas: "355-46-4", aka: ["PFHxS"] },
  { inci: "Perfluorodecanoic acid (PFDA)", cas: "335-76-2", aka: ["PFDA"] },
  { inci: "Perfluorohexanoic acid (PFHxA)", cas: "307-24-4", aka: ["PFHxA"] },
  { inci: "Perfluoroheptanoic acid (PFHpA)", cas: "375-85-9", aka: ["PFHpA"] },
  { inci: "Perfluorobutanesulfonic acid (PFBS)", cas: "375-73-5", aka: ["PFBS"] },
  { inci: "Hexafluoropropylene oxide dimer acid (HFPO-DA, GenX)", cas: "13252-13-6", aka: ["HFPO-DA", "GenX"] },
  { inci: "Perfluoropentanoic acid (PFPeA)", cas: "2706-90-3", aka: ["PFPeA"] },
  { inci: "Perfluorobutanoic acid (PFBA)", cas: "375-22-4", aka: ["PFBA"] },
  { inci: "Perfluorooctanesulfonamide (PFOSA)", cas: "754-91-6", aka: ["PFOSA"] },
  { inci: "Perfluorododecanoic acid (PFDoA)", cas: "307-55-1", aka: ["PFDoA"] },
];

function findOrCreateIngredient(
  ingredients: IngredientRow[],
  byInciLower: Map<string, IngredientRow>,
  byCas: Map<string, IngredientRow>,
  inci: string,
  cas: string | null,
  functionCategory: string | null,
): IngredientRow {
  let ing = byInciLower.get(inci.toLowerCase());
  if (!ing && cas) ing = byCas.get(cas);
  if (ing) {
    if (!ing.cas_no && cas) ing.cas_no = cas;
    return ing;
  }
  ing = {
    id: randomUUID(),
    inci_name: inci,
    korean_name: null, chinese_name: null, japanese_name: null,
    cas_no: cas,
    synonyms: [],
    description: null,
    function_category: functionCategory,
    function_description: null,
  };
  ingredients.push(ing);
  byInciLower.set(inci.toLowerCase(), ing);
  if (cas) byCas.set(cas, ing);
  return ing;
}

async function main() {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInciLower = new Map<string, IngredientRow>();
  const byCas = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    byInciLower.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) { byCas.set(i.cas_no, i); for (const c of i.cas_no.split(/[\s,;/]+/)) { const t = c.trim().replace(/\(.*$/, ""); if (t && t !== i.cas_no) byCas.set(t, i); } }  // 다중 CAS 토큰별 키 추가(쉼표/세미콜론/슬래시·주석strip·분절 방지·전체문자열 키 유지=무회귀)
  }

  const newRegs: RegulationRow[] = [];
  let part73Count = 0, part74Count = 0, ab2762Count = 0;
  let createdCount = 0;
  const initialIngredientCount = ingredients.length;

  // ── 1) Part 73 Subpart C ──────────────────────
  console.log(`\n▶ 21 CFR Part 73 Subpart C — Cosmetics 색소 (인증면제)`);
  const xml73 = await fetchEcfrXml(73, today);
  const part73Entries = extractSubpartC(xml73, 73);
  console.log(`  ${part73Entries.length} sections`);
  for (const e of part73Entries) {
    const ing = findOrCreateIngredient(ingredients, byInciLower, byCas, e.inci, null, "색소");
    newRegs.push({
      ingredient_id: ing.id, country_code: "US", status: "listed",
      max_concentration: null, concentration_unit: "%",
      product_categories: ["색소"],
      conditions: `21 CFR ${e.section} (인증면제 positive list).\n원문: ${e.conditions_text}`,
      source_url: PART73_URL,
      source_document: PART73_DOC,
      source_version: `eCFR-${today}`,
      source_priority: 100, last_verified_at: now,
      confidence_score: 1.0, override_note: null,
    });
    part73Count++;
  }

  // ── 2) Part 74 Subpart C ──────────────────────
  console.log(`\n▶ 21 CFR Part 74 Subpart C — Cosmetics 색소 (인증요구)`);
  const xml74 = await fetchEcfrXml(74, today);
  const part74Entries = extractSubpartC(xml74, 74);
  console.log(`  ${part74Entries.length} sections`);
  for (const e of part74Entries) {
    const ing = findOrCreateIngredient(ingredients, byInciLower, byCas, e.inci, null, "색소");
    newRegs.push({
      ingredient_id: ing.id, country_code: "US", status: "listed",
      max_concentration: null, concentration_unit: "%",
      product_categories: ["색소"],
      conditions: `21 CFR ${e.section} (인증요구 positive list — 매 batch 별 FDA 인증 필요).\n원문: ${e.conditions_text}`,
      source_url: PART74_URL,
      source_document: PART74_DOC,
      source_version: `eCFR-${today}`,
      source_priority: 100, last_verified_at: now,
      confidence_score: 1.0, override_note: null,
    });
    part74Count++;
  }

  // ── 3) California AB 2762 ──────────────────────
  console.log(`\n▶ California AB 2762 — 24 banned (2025-01-01 발효)`);
  for (const b of AB2762_BANS) {
    const ing = findOrCreateIngredient(ingredients, byInciLower, byCas, b.inci, b.cas, null);
    if (b.aka.length > 0) {
      for (const a of b.aka) if (!ing.synonyms.includes(a)) ing.synonyms.push(a);
    }
    const conditionsText = [
      `California AB 2762 (Toxic-Free Cosmetics Act 2020) — 캘리포니아 주 화장품 사용 금지 (2025-01-01 시행).`,
      `CAS: ${b.cas ?? "N/A"}`,
      b.aka.length > 0 ? `별칭: ${b.aka.join(", ")}` : null,
      `해당 성분 함유 화장품의 캘리포니아 주 내 제조·판매·유통 금지.`,
    ].filter(Boolean).join("\n");
    newRegs.push({
      ingredient_id: ing.id, country_code: "US", status: "banned",
      max_concentration: null, concentration_unit: "%",
      product_categories: [],
      conditions: conditionsText,
      source_url: AB2762_URL,
      source_document: AB2762_DOC,
      source_version: "AB2762-2020",
      source_priority: 100, last_verified_at: now,
      confidence_score: 1.0, override_note: "주(state) 법 — 연방 21 CFR 보다 엄격. 캘리포니아 주 내 한정.",
    });
    ab2762Count++;
  }

  createdCount = ingredients.length - initialIngredientCount;

  // F15+ (정품검증): 파싱 0건이면(eCFR 차단·구조변경) 기존 색소 데이터 보존 — strip 후 빈 write 방지.
  if (newRegs.length === 0) {
    console.warn("  ! 색소 파싱 0건 — 기존 regulations 보존 (write 생략)");
    return;
  }
  // 머지: 이 파일의 source_document 들만 교체. 다른 source 보존.
  const sourceDocsToReplace = new Set([PART73_DOC, PART74_DOC, AB2762_DOC]);
  const existingRegs = await readRows<RegulationRow>("regulations");
  const filteredRegs = existingRegs.filter((r) => !sourceDocsToReplace.has(r.source_document));
  const finalRegs = [...filteredRegs, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  Part 73 Subpart C: ${part73Count} 색소`);
  console.log(`  Part 74 Subpart C: ${part74Count} 색소`);
  console.log(`  AB 2762: ${ab2762Count} banned`);
  console.log(`  US regulations 추가: ${newRegs.length} (new ingredients ${createdCount})`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
