import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";
import { geminiRescue, buildRegsFromExtracted } from "../parsers/gemini-fallback";

// 대만 TFDA — 화장품 5 카테고리 1차 소스 fetcher.
// consumer.fda.gov.tw/LAW/Cosmetic1.aspx?nodeID=1068&t=N (N=1,3,5,7,8).
// HTML 테이블 inline → 정규식 파싱 (Gemini 불필요).

const BASE_DOC = "TFDA 化粧品禁限用成分管理規定";
const SOURCE_URL = "https://consumer.fda.gov.tw/LAW/Cosmetic1.aspx?nodeID=1068";

interface TwCategory {
  t: number;
  status: "banned" | "restricted" | "listed";
  source_doc: string;
  label_ko: string;
  function_category: string | null;
}

const CATEGORIES: TwCategory[] = [
  { t: 1, status: "banned",     source_doc: `${BASE_DOC} — 化粧品禁止使用成分表`,         label_ko: "TFDA 화장품 금지 성분", function_category: null },
  { t: 3, status: "restricted", source_doc: `${BASE_DOC} — 化粧品防腐劑成分使用限制表`,    label_ko: "TFDA 화장품 방부제 사용 제한", function_category: "방부제" },
  { t: 5, status: "listed",     source_doc: `${BASE_DOC} — 化粧品色素成分使用限制表`,      label_ko: "TFDA 화장품 색소 positive list", function_category: "색소" },
  { t: 7, status: "restricted", source_doc: `${BASE_DOC} — 化粧品成分使用限制表`,         label_ko: "TFDA 화장품 일반 사용 제한", function_category: null },
  { t: 8, status: "listed",     source_doc: `${BASE_DOC} — 化粧品防曬劑成分使用限制表`,    label_ko: "TFDA 화장품 자외선차단제 positive list", function_category: "자외선차단제" },
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

interface TwEntry {
  no: string;
  inci: string;
  cas: string | null;
  notes: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

async function fetchPage(t: number, p: number): Promise<{ entries: TwEntry[]; totalPages: number }> {
  const url = p === 1
    ? `https://consumer.fda.gov.tw/LAW/Cosmetic1.aspx?nodeID=1068&t=${t}`
    : `https://consumer.fda.gov.tw/LAW/Cosmetic1.aspx?nodeID=1068&t=${t}&p=${p}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0", "Accept-Language": "zh-TW,zh;q=0.9" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for t=${t} p=${p}`);
  const html = await res.text();
  const totalMatch = html.match(/共有\s*(\d+)\s*頁/);
  const totalPages = totalMatch ? Number(totalMatch[1]) : 1;
  const entries: TwEntry[] = [];
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (tbodyMatch) {
    const rowRe = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g;
    let m;
    while ((m = rowRe.exec(tbodyMatch[1]))) {
      const no = stripTags(m[1]);
      const inci = stripTags(m[2]);
      const cas = stripTags(m[3]) || null;
      const notes = stripTags(m[4]) || null;
      // header row 또는 한자 only skip
      if (inci && /[A-Za-z]/.test(inci)) entries.push({ no, inci, cas, notes });
    }
  }
  return { entries, totalPages };
}

async function fetchCategory(cat: TwCategory): Promise<TwEntry[]> {
  const all: TwEntry[] = [];
  const first = await fetchPage(cat.t, 1);
  all.push(...first.entries);
  for (let p = 2; p <= first.totalPages; p++) {
    const { entries } = await fetchPage(cat.t, p);
    all.push(...entries);
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`  t=${cat.t} (${cat.label_ko}): ${all.length} entries (${first.totalPages} pages)`);
  return all;
}

// 폴백 전용: 카테고리 첫 페이지 raw HTML (Gemini 에 넘길 원본). 실패 시 빈 문자열.
async function fetchRawFirstPage(t: number): Promise<string> {
  try {
    const res = await fetch(`https://consumer.fda.gov.tw/LAW/Cosmetic1.aspx?nodeID=1068&t=${t}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0", "Accept-Language": "zh-TW,zh;q=0.9" },
    });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
}

async function main() {
  const startedAt = Date.now();
  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInciLower = new Map<string, IngredientRow>();
  for (const i of ingredients) byInciLower.set(i.inci_name.toLowerCase(), i);

  const now = new Date().toISOString();
  const sourceVersion = `TFDA-${now.slice(0, 10)}`;

  // 1. 모든 TFDA 행 제거 (이전 잘못된 status 데이터 정리)
  // 과거 fetcher 가 BASE_DOC prefix 없이 생성한 stale source_document 까지 잡으려고
  // "TFDA" substring 으로 확장. country_code=TW 의 모든 우리 source 도 함께 정리.
  const existingRegs = await readRows<RegulationRow>("regulations");
  const otherSources = existingRegs.filter((r) =>
    !r.source_document.includes(BASE_DOC) &&
    !r.source_document.startsWith("TFDA "),
  );
  console.log(`▶ TFDA 5 카테고리 fetch (기존 TFDA rows ${existingRegs.length - otherSources.length} 삭제)`);

  const newRegs: RegulationRow[] = [];
  let totalMatched = 0, totalCreated = 0;

  for (const cat of CATEGORIES) {
    const entries = await fetchCategory(cat);
    let matched = 0, created = 0;
    for (const e of entries) {
      const key = e.inci.toLowerCase();
      let ing = byInciLower.get(key);
      if (!ing) {
        ing = {
          id: randomUUID(),
          inci_name: e.inci,
          korean_name: null, chinese_name: null, japanese_name: null,
          cas_no: e.cas, synonyms: [], description: null,
          function_category: cat.function_category,
          function_description: null,
        };
        ingredients.push(ing);
        byInciLower.set(key, ing);
        created++;
      } else {
        matched++;
        if (!ing.cas_no && e.cas) ing.cas_no = e.cas;
      }
      const conds = [
        `${cat.label_ko} 등재 — ${cat.status === "banned" ? "사용 금지" : cat.status === "listed" ? "사용 가능 (positive list)" : "사용 제한"}.`,
        e.no ? `項次 ${e.no}` : null,
        e.notes ? `비고 (備註 원문): ${e.notes}` : null,
      ].filter(Boolean).join("\n\n");
      newRegs.push({
        ingredient_id: ing.id, country_code: "TW", status: cat.status,
        max_concentration: null, concentration_unit: "%",
        product_categories: cat.function_category ? [cat.function_category] : [],
        conditions: conds, source_url: SOURCE_URL, source_document: cat.source_doc,
        source_version: sourceVersion, source_priority: 100, last_verified_at: now,
        confidence_score: 1.0, override_note: null,
      });
    }
    totalMatched += matched; totalCreated += created;
    console.log(`     → matched ${matched}, new ${created}`);
  }

  // 전 카테고리 0건 = TFDA HTML 테이블 양식 변경 신호 → 원본 HTML 을 Gemini 폴백 1회.
  // 정상(>0)이면 이 분기 미실행 → 기존 동작과 100% 동일(부작용 0).
  if (newRegs.length === 0) {
    const rawHtml = (await Promise.all(CATEGORIES.map((c) => fetchRawFirstPage(c.t)))).join("\n\n<!-- next category -->\n\n");
    if (rawHtml.trim()) {
      const tmp = join(tmpdir(), `tw-tfda-fallback-${process.pid}.html`);
      writeFileSync(tmp, rawHtml, "utf8");
      const rescued = await geminiRescue({ filePath: tmp, country: "TW", title: BASE_DOC, url: SOURCE_URL });
      try { unlinkSync(tmp); } catch { /* temp 정리 실패 무시 */ }
      if (rescued.length > 0) {
        newRegs.push(...buildRegsFromExtracted({ regs: rescued, ingredients, country: "TW", sourceDoc: `${BASE_DOC} (Gemini 폴백)`, sourceUrl: SOURCE_URL, now }));
        console.log(`  ⚠ 정규식 0건 → Gemini 폴백 ${newRegs.length}건 확보 (confidence 0.75)`);
      }
    }
  }

  // F15: 소프트 파싱 실패(HTTP 200 + HTML 구조 변경 → 0~소수 행) 시 기존 TFDA 데이터가
  // 빈 set 으로 덮어써지는 소실 방지. 결과가 기존의 50% 미만이면(기존이 유의미할 때) 중단.
  const prevTfda = existingRegs.length - otherSources.length;
  if (prevTfda > 100 && newRegs.length < prevTfda * 0.5) {
    console.error(`✗ TFDA 파싱 결과 ${newRegs.length} 행 < 기존 ${prevTfda} 의 50% — 사이트 구조 변경 의심. 데이터 보존 위해 중단(write 안 함).`);
    process.exit(1);
  }

  const finalRegs = [...otherSources, ...newRegs];
  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  console.log(`\n=== summary (${((Date.now()-startedAt)/1000).toFixed(1)}s) ===`);
  console.log(`  TFDA total: ${newRegs.length} rows (priority 100)`);
  console.log(`  matched ${totalMatched}, new ${totalCreated}`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
