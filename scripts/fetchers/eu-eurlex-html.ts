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
      if (res.ok) { const t = await res.text(); if (t.length > 1_000_000) { html = t; console.log(`  사용: ${u} (${(t.length / 1e6).toFixed(1)}MB)`); break; } }
    } catch { /* 다음 후보 */ }
  }
  // 🎯 archive.org Wayback 폴백 — EUR-Lex(CloudFront)가 **GitHub Actions IP 를 403 차단**(로컬 IP 는 통과)
  // 해서 CI 에선 직접 fetch 가 전부 막혀 EU 갱신이 멈췄다(실측: CI 캐시=403 "Request blocked"). Wayback
  // 은 IP 차단 없고 현행 스냅샷 보유(실측 2026-05 스냅샷=Homosalate 7.34% 현행) → 차단 우회. availability
  // API 로 최신 스냅샷 찾고 `id_`(raw, Wayback 툴바 미주입) 로 본문 취득. 결정론·무AI.
  if (!html) {
    try {
      const api = "https://archive.org/wayback/available?url=eur-lex.europa.eu/eli/reg/2009/1223";
      const j = await (await fetch(api, { signal: AbortSignal.timeout(30_000) })).json();
      const snap = j?.archived_snapshots?.closest;
      if (snap?.url) {
        const raw = snap.url.replace(/(\/web\/\d+)\//, "$1id_/").replace(/^http:/, "https:");
        const res = await fetch(raw, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
        if (res.ok) { const t = await res.text(); if (t.length > 1_000_000) { html = t; console.log(`  사용: archive.org Wayback ${snap.timestamp} (${(t.length / 1e6).toFixed(1)}MB)`); } }
      }
    } catch { /* Wayback 도 실패 */ }
  }
  if (!html) { console.error("✗ 통합본 HTML 못 받음(직접+Wayback) — 보존(write 생략)"); process.exit(1); }

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
  // Annex II(금지) 인데 DB 에 없는 *유효 CAS·실명* 물질은 **생성**(전수 완비). 최근 CLP Omnibus 로
  // Annex II 에 추가된 CMR 살충제·공업화학물(예 Metaldehyde·Clothianidin·dibutyltin)이 DB 부재라
  // "검색 미도달"이던 것 — 금지 누락은 완전성 손실. 결정론 ID(euban-<CAS>)=멱등(매 crawl 재생성 0).
  // 안전조건: Annex II + 유효 CAS + 실 화학명(카테고리/placeholder 제외) + DB 에 그 CAS 부재. 생성물은
  // 영문 화학명(금지 CMR 라 한글표준명 불필요)·banned·EU 출처. dedup: 기존 CAS 보유시 생성 안 함.
  const createdIng: IngredientRow[] = [];
  const cleanBanName = (s: string): string =>
    s.replace(/\s*\((?:ISO|INN|EC)\)/gi, "").replace(/;.*$/, "").replace(/\s{2,}/g, " ").trim();
  const isRealName = (s: string): boolean =>
    s.length >= 3 && !/^(moved|deleted|reserved)\b/i.test(s) &&
    !/^(salts?|esters?|derivatives?|compounds?|substances?|materials?|narcotics?|vaccines?|toxins?)\b/i.test(s) &&
    /[a-z]{3}/i.test(s);
  let matched = 0, skipped = 0, created = 0;
  for (const r of rows) {
    let ing = (r.cas && byCas.get(r.cas)) || byInci.get(r.name.toLowerCase());
    if (!ing) {
      // 미매칭 Annex II 금지 + 유효 CAS + 실명 → 생성(완전성). 그 외(제한/허용·CAS無·카테고리)는 skip 유지.
      const nm = cleanBanName(r.name);
      if (r.annex === "II" && r.cas && /^\d{2,7}-\d{2}-\d$/.test(r.cas) && isRealName(nm) && !byCas.has(r.cas)) {
        ing = {
          id: `euban-${r.cas}`, inci_name: nm, korean_name: null, chinese_name: null, japanese_name: null,
          cas_no: r.cas, synonyms: [], description: null, function_category: null, function_description: null,
        };
        byCas.set(r.cas, ing); byInci.set(nm.toLowerCase(), ing);
        createdIng.push(ing); created++;
      } else { skipped++; continue; }
    }
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
  console.log(`  매칭 ${matched}, 미매칭 skip ${skipped}, 신규 금지물질 생성 ${created}, 규제행 ${newRegs.length}`);

  // 신규 생성 금지물질을 ingredients.json 에 멱등 추가(id=euban-<CAS> 중복시 skip). 결정론·완전성.
  if (createdIng.length) {
    const allIng = await readRows<IngredientRow>("ingredients");
    const have = new Set(allIng.map((i) => i.id));
    const toAdd = createdIng.filter((i) => !have.has(i.id));
    if (toAdd.length) { await writeRows("ingredients", [...allIng, ...toAdd]); console.log(`  ✓ 신규 금지물질 ${toAdd.length} 성분 생성(euban-<CAS>, 멱등)`); }
  }

  const existing = await readRows<RegulationRow>("regulations");
  // 기존 EU EUR-Lex 소스 행(깨진 PDF "Cosmetic Products" + 이전 HTML 포함) 전부 교체 →
  // EU EUR-Lex = 이 HTML 파서가 단일 출처. (MFDS EU 자료 등 타 출처는 보존.)
  const other = existing.filter((r) => !(r.source_document || "").startsWith("EU EUR-Lex"));
  await writeRows("regulations", [...other, ...newRegs]);
  console.log(`✓ EU Annex II~VI HTML: ${newRegs.length} regulations (priority 100, 매칭 전용·중복생성 0)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
