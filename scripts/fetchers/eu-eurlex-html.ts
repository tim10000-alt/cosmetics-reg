import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows } from "../../lib/json-store";

// EU Cosmetic Regulation 1223/2009 — EUR-Lex *consolidated HTML* 파서.
// 깨진 PDF(eu-eurlex-parse.ts)는 텍스트 추출 시 표가 역순/뒤섞임 → 한도 못 뽑음.
// 정식 HTML 본문은 표가 깨끗(셀 분리)하므로 결정론적으로 한도·조건까지 추출 가능.
// → Gemini 불필요, 매일 자동, 너 없어도 무료로 동작.
//
// Annex III (사용 제한 + 한도) 우선. 행 셀: [ref][화학명][관용명?][CAS][EC][제품유형][최대농도][기타][경고].
// 셀 수가 행마다 달라 위치가 아니라 '내용 패턴'(CAS/EC/% 정규식)으로 식별 — robust.

const SOURCE_DOC = "EU EUR-Lex 1223/2009 Annex III (HTML consolidated)";
const SOURCE_URL = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02009R1223";
// 통합본 HTML 후보 — 최신 우선, 안 되면 알려진 dated 통합본으로 fallback("그때그때" + robust).
// 미래에 더 최신 통합본이 나오면 앞쪽 dated 후보를 추가하면 됨.
const HTML_URLS = [
  "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02009R1223-20250401",
  "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02009R1223-20240601",
  "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02009R1223-20231201",
];

interface IngredientRow {
  id: string; inci_name: string; korean_name: string | null; chinese_name: string | null;
  japanese_name: string | null; cas_no: string | null; synonyms: string[];
  description: string | null; function_category: string | null; function_description: string | null;
}
interface RegulationRow {
  ingredient_id: string; country_code: string; status: string; max_concentration: number | null;
  concentration_unit: string; product_categories: string[]; conditions: string | null;
  source_url: string | null; source_document: string; source_version: string | null;
  source_priority: number; last_verified_at: string; confidence_score: number; override_note: string | null;
}

const CAS_RE = /\b\d{1,7}-\d{2}-\d\b/;
const EC_RE = /\b\d{3}-\d{3}-\d\b/;

function cellText(td: string): string {
  return td.replace(/<[^>]+>/g, " ").replace(/&#160;|&nbsp;/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ").trim();
}

// 다중값("(a) 3,0 % (b) 2,0 %")이면 null, 단일값이면 숫자(EU 콤마소수 → 점). 안전.
function singleMax(maxCell: string): number | null {
  const vals = [...new Set([...maxCell.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) => m[1].replace(",", ".")))];
  if (vals.length !== 1) return null;
  const n = Number(vals[0]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

interface AnnexRow { ref: string; name: string; cas: string | null; ec: string | null; productType: string; maxCell: string; conditions: string; }

function parseAnnexIII(html: string): AnnexRow[] {
  // Annex III 섹션 한정: "ANNEX III" ~ "ANNEX IV"
  const a = html.search(/ANNEX\s+III\b/);
  const b = html.search(/ANNEX\s+IV\b/);
  const section = a >= 0 ? html.slice(a, b > a ? b : undefined) : html;
  const out: AnnexRow[] = [];
  for (const trM of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...trM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cellText(m[1]));
    if (cells.length < 6) continue;
    // 내용 기반 식별
    const casIdx = cells.findIndex((c) => CAS_RE.test(c));
    const ref = /^\d{1,4}$/.test(cells[0]) ? cells[0] : "";
    if (!ref) continue; // ref number 로 시작하는 실제 데이터 행만
    const cas = casIdx >= 0 ? (cells[casIdx].match(CAS_RE)?.[0] ?? null) : null;
    const ecIdx = cells.findIndex((c, i) => i !== casIdx && EC_RE.test(c) && !CAS_RE.test(c));
    // 이름 = ref 다음 ~ CAS 전 셀들 중 가장 긴 것(관용명/화학명)
    const nameCells = cells.slice(1, casIdx >= 0 ? casIdx : 3).filter((c) => c && !/^\(\s*\d+\s*\)$/.test(c));
    const name = nameCells.sort((x, y) => y.length - x.length)[0] || nameCells[0] || "";
    // 한도 셀 = % 포함 셀(보통 CAS/EC 뒤). 제품유형 셀 = 한도 셀 직전, 조건 = 그 뒤 셀들.
    const afterId = Math.max(casIdx, ecIdx) + 1;
    const tail = cells.slice(afterId >= 1 ? afterId : 5);
    const maxIdx = tail.findIndex((c) => /\d+(?:[.,]\d+)?\s*%/.test(c));
    const maxCell = maxIdx >= 0 ? tail[maxIdx] : "";
    const productType = maxIdx > 0 ? tail[maxIdx - 1] : "";
    const conditions = tail.slice(maxIdx >= 0 ? maxIdx + 1 : 0).join(" / ");
    if (!name || name.length < 2) continue;
    out.push({ ref, name, cas, ec: ecIdx >= 0 ? (cells[ecIdx].match(EC_RE)?.[0] ?? null) : null, productType, maxCell, conditions });
  }
  return out;
}

async function main() {
  console.log(`▶ EU EUR-Lex HTML 파싱...`);
  let html = "";
  for (const u of HTML_URLS) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" }, redirect: "follow" });
      if (res.ok) { const t = await res.text(); if (t.length > 1_000_000) { html = t; console.log(`  사용: ${u.split("uri=")[1]} (${(t.length / 1e6).toFixed(1)}MB)`); break; } }
    } catch { /* 다음 후보 */ }
  }
  if (!html) { console.error(`✗ 통합본 HTML 못 받음 — 기존 데이터 보존(write 생략)`); process.exit(1); }
  const rows = parseAnnexIII(html);
  console.log(`  Annex III 파싱: ${rows.length} 행`);

  // 데이터 보존 가드: 너무 적으면(구조 변경/차단) 중단.
  if (rows.length < 50) { console.error(`✗ ${rows.length}행 — 구조 변경 의심, 보존 위해 중단`); process.exit(1); }

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byCas = new Map<string, IngredientRow>(), byInci = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    byInci.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) for (const c of String(i.cas_no).split(/\s+/)) if (c.trim()) byCas.set(c.trim(), i);
  }

  const now = new Date().toISOString();
  const version = `1223-HTML-${now.slice(0, 10)}`;
  const newRegs: RegulationRow[] = [];
  let matched = 0, skipped = 0;
  for (const r of rows) {
    // dedup 안전: 기존 성분에 CAS(우선) 또는 이름으로 매칭만. 미매칭은 skip(중복 생성 금지 —
    // siblingIds 가 CAS 로 병합하므로 같은 CAS 의 어느 행에 붙어도 검색 시 표시됨).
    const ing = (r.cas && byCas.get(r.cas)) || byInci.get(r.name.toLowerCase());
    if (!ing) { skipped++; continue; }
    matched++;
    const condParts = [
      `EU 1223/2009 Annex III (Ref ${r.ref}) — 사용 제한.`,
      r.productType ? `제품 유형: ${r.productType}` : null,
      r.maxCell ? `최대 농도: ${r.maxCell}` : null,
      r.conditions ? `조건: ${r.conditions}` : null,
      r.cas ? `CAS: ${r.cas}` : null,
    ].filter(Boolean).join("\n");
    newRegs.push({
      ingredient_id: ing.id, country_code: "EU", status: "restricted",
      max_concentration: singleMax(r.maxCell), concentration_unit: "%",
      product_categories: [], conditions: condParts,
      source_url: SOURCE_URL, source_document: SOURCE_DOC, source_version: version,
      source_priority: 100, last_verified_at: now, confidence_score: 1.0, override_note: null,
    });
  }
  console.log(`  매칭 ${matched}, 미매칭 skip ${skipped}, 규제행 ${newRegs.length}`);

  const existing = await readRows<RegulationRow>("regulations");
  const other = existing.filter((r) => r.source_document !== SOURCE_DOC);
  await writeRows("regulations", [...other, ...newRegs]);
  console.log(`✓ EU Annex III HTML: ${newRegs.length} regulations (priority 100, 매칭 전용·중복생성 0)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
