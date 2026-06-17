import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows } from "../../lib/json-store";

// EU Cosmetic Regulation 1223/2009 — EUR-Lex *consolidated HTML* 파서 (Annex II~VI 전부).
// 깨진 PDF(텍스트 역순/뒤섞임) 대신 정식 HTML 본문은 표가 깨끗 → 결정론적으로 한도·조건 추출.
// Gemini 불필요·매일 자동(=너 없어도 무료 전자동, HTML-first). 셀을 내용패턴(CAS/EC/%)으로
// 식별해 annex 별 열 구조 차이에도 robust. dedup 안전: 기존 성분 매칭만·미매칭 skip(중복생성 0).

const SOURCE_DOC = "EU EUR-Lex 1223/2009 (HTML consolidated)";
const SOURCE_REF = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02009R1223";
// 🎯 ELI URL 1순위 — *날짜 없는* ELI 가 EUR-Lex 에서 항상 **최신 통합본**으로 자동 resolve(naive fetch
// 200·4.1MB·현행). 날짜 박힌 CELEX URL 들은 통합 시점이 지나면 404 가 되어(원문 재추출 감사로 실측:
// 02009R1223-20250401 등 전부 404 → 파서가 현행 fetch 실패·보존만 → EUR-Lex 데이터 stale, 2024 나노
// 실버·2023 향료알레르겐 등 최신개정 누락) 갱신이 멈췄다. ELI 는 하드코딩 날짜가 없어 영구 현행 유지.
const HTML_URLS = [
  "https://eur-lex.europa.eu/eli/reg/2009/1223",
  "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02009R1223-20250401",
  "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02009R1223-20240601",
  "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02009R1223-20231201",
];
// annex → status. II=금지, III=제한, IV/V/VI=positive list(허용, 한도 보유).
const ANNEXES: { name: string; next: string | null; status: string; label: string }[] = [
  { name: "II", next: "III", status: "banned", label: "Annex II 금지" },
  { name: "III", next: "IV", status: "restricted", label: "Annex III 제한" },
  { name: "IV", next: "V", status: "listed", label: "Annex IV 색소 허용" },
  { name: "V", next: "VI", status: "listed", label: "Annex V 보존제 허용" },
  { name: "VI", next: "VII", status: "listed", label: "Annex VI 자외선차단제 허용" },
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
interface AnnexRow { ref: string; name: string; cas: string | null; ec: string | null; productType: string; maxCell: string; conditions: string; annex: string; status: string; }

const CAS_RE = /\b\d{1,7}-\d{2}-\d\b/;
const EC_RE = /\b\d{3}-\d{3}-\d\b/;

function cellText(td: string): string {
  return td.replace(/<[^>]+>/g, " ").replace(/&#160;|&nbsp;/g, " ").replace(/&[a-z#0-9]+;/g, " ")
    // EUR-Lex 통합본 개정 마커(►M4·►C1·►B·►A2 = 변경 출처, ◄ = 닫기) 제거. 미제거 시
    // ref 셀이 "►M4 22" 가 되어 숫자 검사 실패 → 개정된 물질(Resorcinol 등)이 전부 누락됨.
    .replace(/►\s*[A-Z]\d*|◄/g, " ")
    .replace(/\s+/g, " ").trim();
}
function singleMax(maxCell: string): number | null {
  const vals = [...new Set([...maxCell.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) => m[1].replace(",", ".")))];
  if (vals.length !== 1) return null;
  const n = Number(vals[0]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

function parseAnnex(html: string, annexName: string, nextName: string | null, status: string): AnnexRow[] {
  const a = html.search(new RegExp(`ANNEX\\s+${annexName}\\b`));
  if (a < 0) return [];
  let b = html.length;
  if (nextName) { const rel = html.slice(a + 6).search(new RegExp(`ANNEX\\s+${nextName}\\b`)); if (rel >= 0) b = a + 6 + rel; }
  const section = html.slice(a, b);
  const out: AnnexRow[] = [];
  for (const trM of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...trM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cellText(m[1]));
    if (cells.length < 3) continue;
    const ref = /^\d{1,4}[a-z]?$/.test(cells[0]) ? cells[0] : "";
    if (!ref) continue; // ref number 로 시작하는 데이터 행만
    const casIdx = cells.findIndex((c) => CAS_RE.test(c));
    const cas = casIdx >= 0 ? (cells[casIdx].match(CAS_RE)?.[0] ?? null) : null;
    const ecIdx = cells.findIndex((c, i) => i !== casIdx && EC_RE.test(c) && !CAS_RE.test(c));
    const nameEnd = casIdx >= 0 ? casIdx : Math.min(3, cells.length);
    const nameCells = cells.slice(1, nameEnd).filter((c) => c && !/^\(\s*\d+\s*\)$/.test(c));
    const name = nameCells.sort((x, y) => y.length - x.length)[0] || nameCells[0] || "";
    const afterId = Math.max(casIdx, ecIdx) + 1;
    const tail = cells.slice(afterId >= 1 ? afterId : nameEnd);
    const maxIdx = tail.findIndex((c) => /\d+(?:[.,]\d+)?\s*%/.test(c));
    const maxCell = maxIdx >= 0 ? tail[maxIdx] : "";
    const productType = maxIdx > 0 ? tail[maxIdx - 1] : "";
    const conditions = tail.slice(maxIdx >= 0 ? maxIdx + 1 : 0).join(" / ");
    if (!name || name.length < 2) continue;
    out.push({ ref, name, cas, ec: ecIdx >= 0 ? (cells[ecIdx].match(EC_RE)?.[0] ?? null) : null, productType, maxCell, conditions, annex: annexName, status });
  }
  return out;
}

async function main() {
  console.log("▶ EU EUR-Lex HTML 파싱 (Annex II~VI)...");
  let html = "";
  for (const u of HTML_URLS) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" }, redirect: "follow" });
      if (res.ok) { const t = await res.text(); if (t.length > 1_000_000) { html = t; console.log(`  사용: ${u.split("uri=")[1]} (${(t.length / 1e6).toFixed(1)}MB)`); break; } }
    } catch { /* 다음 후보 */ }
  }
  if (!html) { console.error("✗ 통합본 HTML 못 받음 — 보존(write 생략)"); process.exit(1); }

  const rows: AnnexRow[] = [];
  for (const a of ANNEXES) {
    const r = parseAnnex(html, a.name, a.next, a.status);
    console.log(`  ${a.label}: ${r.length} 행`);
    rows.push(...r);
  }
  if (rows.length < 200) { console.error(`✗ 총 ${rows.length}행 — 구조 변경 의심, 보존 위해 중단`); process.exit(1); }

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byCas = new Map<string, IngredientRow>(), byInci = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    byInci.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) for (const c of String(i.cas_no).split(/[\s,;]+/)) if (c.trim()) byCas.set(c.trim(), i);  // 쉼표/세미콜론 분리(다중 CAS 매칭, lib 미러)
  }

  const now = new Date().toISOString();
  const version = `1223-HTML-${now.slice(0, 10)}`;
  const newRegs: RegulationRow[] = [];
  let matched = 0, skipped = 0;
  for (const r of rows) {
    const ing = (r.cas && byCas.get(r.cas)) || byInci.get(r.name.toLowerCase());
    if (!ing) { skipped++; continue; }
    matched++;
    const cond = [
      `EU 1223/2009 Annex ${r.annex} (Ref ${r.ref}) — ${r.status === "banned" ? "사용 금지" : r.status === "restricted" ? "사용 제한" : "positive list(허용)"}.`,
      r.productType ? `제품 유형: ${r.productType}` : null,
      r.maxCell ? `최대 농도: ${r.maxCell}` : null,
      r.conditions ? `조건: ${r.conditions}` : null,
      r.cas ? `CAS: ${r.cas}` : null,
    ].filter(Boolean).join("\n");
    newRegs.push({
      ingredient_id: ing.id, country_code: "EU", status: r.status,
      max_concentration: singleMax(r.maxCell), concentration_unit: "%",
      product_categories: [], conditions: cond,
      source_url: SOURCE_REF, source_document: SOURCE_DOC, source_version: version,
      source_priority: 100, last_verified_at: now, confidence_score: 1.0, override_note: null,
    });
  }
  console.log(`  매칭 ${matched}, 미매칭 skip ${skipped}, 규제행 ${newRegs.length}`);

  const existing = await readRows<RegulationRow>("regulations");
  // 기존 EU EUR-Lex 소스 행(깨진 PDF "Cosmetic Products" + 이전 HTML 포함) 전부 교체 →
  // EU EUR-Lex = 이 HTML 파서가 단일 출처. (MFDS EU 자료 등 타 출처는 보존.)
  const other = existing.filter((r) => !(r.source_document || "").startsWith("EU EUR-Lex"));
  await writeRows("regulations", [...other, ...newRegs]);
  console.log(`✓ EU Annex II~VI HTML: ${newRegs.length} regulations (priority 100, 매칭 전용·중복생성 0)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
