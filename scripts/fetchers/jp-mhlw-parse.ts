import "./pdf-polyfill";   // 환경 독립 — pdf-parse 가 구버전 Node 에서도 동작 (pdf-parse import 전 필수)
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// JP MHLW 化粧品基準 영문 PDF text → ingredient 매칭 + JSON 머지.
// pdf-parse 로 text 추출 → Appendix 1 (banned 30) + Appendix 3 (preservative
// positive ~16) + Appendix 4 (UV positive ~30) 파싱. Gemini 불필요 — 영문 PDF
// 이라 정규식 직접.

const SOURCE_DOC = "JP MHLW 化粧品基準 (Standards for Cosmetics, Notification 331)";
const SOURCE_URL = "https://www.mhlw.go.jp/content/000491511.pdf";
const PDF_EN_PATH = ".crawl-raw/jp-mhlw/jp_mhlw_cosmetic_standards_en.pdf";

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

async function extractText(): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const buf = readFileSync(PDF_EN_PATH);
  const p = new PDFParse({ data: buf });
  const r = await p.getText();
  return r.text;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSection(text: string, header: string, nextHeader: string | null): string {
  // 본문 reference 와 section header 구분: 줄 시작 + 줄 끝 패턴 + 마지막 매치.
  const headerPattern = new RegExp(`(^|\\n)${escapeRe(header)}\\s*\\n`, "g");
  const matches = [...text.matchAll(headerPattern)];
  if (matches.length === 0) return "";
  const lastMatch = matches[matches.length - 1];
  const start = (lastMatch.index ?? 0) + lastMatch[0].length;
  let end = text.length;
  if (nextHeader) {
    const nextPattern = new RegExp(`(^|\\n)${escapeRe(nextHeader)}`, "g");
    const nextMatches = [...text.matchAll(nextPattern)];
    if (nextMatches.length > 0) {
      // start 이후 첫 번째 다음 header
      for (const nm of nextMatches) {
        if ((nm.index ?? 0) > start) {
          end = nm.index ?? text.length;
          break;
        }
      }
    }
  }
  return text.slice(start, end);
}

interface ParsedItem {
  name: string;
  status: "banned" | "restricted" | "listed";
  max_concentration: number | null;
  conditions: string;
}

function parseAppendix1(text: string): ParsedItem[] {
  // "1. ingredient" 형식 numbered list. 30개.
  const out: ParsedItem[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s+(.+?)\s*$/);
    if (!m) continue;
    const num = Number(m[1]);
    const name = m[2].trim();
    // 30개까지만 (Appendix 1 종료)
    if (num > 30 || !name) continue;
    // skip footer markers
    if (/^--/.test(name)) continue;
    out.push({
      name,
      status: "banned",
      max_concentration: null,
      conditions: `JP MHLW 化粧品基準 別表 1 (Appendix 1) 등재 — 화장품 사용 금지 ingredient. (告示 331).`,
    });
  }
  return out;
}

function parseAmountTable(text: string, sectionName: string, status: "restricted" | "listed"): ParsedItem[] {
  // "ingredient name 0.X" 형식 라인. 한 줄에 한 ingredient.
  // amount 단위: "0.20", "1.0 as total", "0.0020 as total"
  const out: ParsedItem[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // header / footer skip
    if (/Ingredient name|Maximum amount|Cosmetics |^--|^[0-9]+\.\s|^Appendix /.test(trimmed)) continue;
    if (/^\(\*\d+\)/.test(trimmed)) continue;
    // 끝에 숫자 + (옵션) "as total" / 단위
    const m = trimmed.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:as total|g|%|IU)?\s*$/);
    if (m) {
      const name = m[1].trim();
      const amount = Number(m[2]);
      // ingredient 이름은 보통 영문 + 일부 화학명. 너무 짧거나 footer/header 텍스트 skip.
      if (name.length < 3 || /^[a-z][.:]/.test(name)) continue;
      // header 텍스트 ("ingredient per", "Maximum amount" 등) 제거
      if (/^(ingredient|maximum|cosmetics|amount)\b/i.test(name)) continue;
      out.push({
        name,
        status,
        max_concentration: amount,
        conditions: `${sectionName} 등재 — ${status === "listed" ? "사용 가능 (positive list)" : "사용 제한"}, 최대 농도 ${amount}g/100g (${status === "listed" ? "보존제/UV 흡수제 등 positive list" : "한정 사용"}).`,
      });
    }
  }
  return out;
}

// Appendix 2 §2: 카테고리(rinse-off / leave-on / mucosa-area / toothpaste 등)별 제한.
// 한 줄에 "<ingredient> Prohibited" 또는 "<ingredient> N.NN g" 인 inline 패턴, 그리고
// 두 줄에 걸친 "<ingredient>\nProhibited" 또는 "<ingredient>\nN.NN g" 패턴 둘 다 처리.
// 카테고리는 별도 row 로 분리하지 않고 ingredient 단위로 압축. 단, 동일 (name, status,
// amount) 쌍은 dedupe.
function parseAppendix2Section2(text: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  // 카테고리 헤더로 보이는 라인 (skip + ingredient pendingName 무효화)
  const isCategory = (s: string) =>
    /^(Cosmetics|Aerosol|Compounds|Hair setting|Toothpaste|use such|immediately|containing|added |only |for purposes|emulsifying|to be used|with the purpose|amount of bee|exclude those|include those)/i.test(s);
  let pendingName = "";
  const pushItem = (name: string, status: "banned" | "restricted", amount: number | null, unit: string) => {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (cleaned.length < 3) return;
    if (!/^[A-Za-z0-9(]/.test(cleaned)) return;
    if (isCategory(cleaned)) return;
    out.push({
      name: cleaned,
      status,
      max_concentration: amount,
      conditions:
        status === "banned"
          ? "JP MHLW 化粧品基準 別表 2 §2 — 특정 화장품 카테고리(rinse-off / leave-on / mucosa / toothpaste 등)에서 사용 금지."
          : `JP MHLW 化粧品基準 別表 2 §2 — 특정 화장품 카테고리에서 최대 ${amount}${unit}.`,
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (/^--|^\d+\s*$|^Ingredient name|^Maximum amount|^[0-9]+\.\s/.test(line)) {
      pendingName = "";
      continue;
    }
    if (isCategory(line)) {
      pendingName = "";
      continue;
    }
    // inline "<name> Prohibited"
    const inlineProhib = line.match(/^(.+?)\s+Prohibited\s*$/i);
    if (inlineProhib) {
      pushItem(inlineProhib[1].trim(), "banned", null, "");
      pendingName = "";
      continue;
    }
    // inline "<name> 0.30g" or "<name> 0.30 g" or "<name> 50000 IU as total"
    const inlineAmount = line.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?)\s*(g|ｇ|%|IU)(?:\s+as\s+total)?\s*$/i);
    if (inlineAmount) {
      pushItem(inlineAmount[1].trim(), "restricted", Number(inlineAmount[2]), inlineAmount[3]);
      pendingName = "";
      continue;
    }
    // standalone "Prohibited"
    if (/^Prohibited$/i.test(line)) {
      if (pendingName) pushItem(pendingName, "banned", null, "");
      pendingName = "";
      continue;
    }
    // standalone amount
    const standaloneAmt = line.match(/^([0-9]+(?:\.[0-9]+)?)\s*(g|ｇ|%|IU)(?:\s+as\s+total)?\b/i);
    if (standaloneAmt) {
      if (pendingName) pushItem(pendingName, "restricted", Number(standaloneAmt[1]), standaloneAmt[2]);
      pendingName = "";
      continue;
    }
    // ingredient 후보로 누적 (영문 시작)
    if (/^[A-Z(]/.test(line)) pendingName = line;
  }
  // dedupe (name, status, amount)
  const seen = new Set<string>();
  return out.filter((it) => {
    const k = `${it.name.toLowerCase()}|${it.status}|${it.max_concentration ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Appendix 2 §3: 3-column 표. 각 row = "<ingredient> <c1> <c2> [<c3>]" — c1=rinse-off,
// c2=leave-on (mucosa 비사용), c3=mucosa 가능. ○ = 무제한, blank = 사용 금지.
// 정책: 가장 strict 카테고리 (mucosa 가능) 의 농도가 있으면 그 수치로, 없으면
// leave-on 수치로 max_concentration 결정. mucosa 사용 가능 여부는 conditions 에 명시.
function parseAppendix2Section3(text: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^--|^\d+\s*$|^Ingredient name|^Maximum amount|^Cosmetics |^be |^for |^washed|^[0-9]+\.\s|^\(\*/.test(trimmed)) continue;
    // pattern: <name> <c1> <c2> [<c3>] — 각 column 은 ○ 또는 0.XX
    const m = trimmed.match(/^(.+?)\s+([○]|[0-9]+(?:\.[0-9]+)?)\s+([○]|[0-9]+(?:\.[0-9]+)?)(?:\s+([○]|[0-9]+(?:\.[0-9]+)?))?\s*$/);
    if (!m) continue;
    const name = m[1].replace(/\s*\(\*\d+\)\s*/g, "").trim();
    if (name.length < 3) continue;
    if (!/^[A-Za-z]/.test(name)) continue;
    const c1 = m[2], c2 = m[3], c3 = m[4] || "";
    const fmt = (v: string) => (v === "○" ? "무제한" : v === "" ? "사용 금지" : `${v}g/100g`);
    const cond =
      `JP MHLW 化粧品基準 別表 2 §3 — 카테고리별 제한. ` +
      `washed-away rinse-off ${fmt(c1)}, ` +
      `leave-on (mucosa 비사용) ${fmt(c2)}, ` +
      `mucosa 사용 ${fmt(c3)}.`;
    // strictest 농도: mucosa column 우선, 없으면 leave-on
    const pickAmount = (v: string) => (v === "○" || v === "" ? null : Number(v));
    const amount = c3 ? pickAmount(c3) : pickAmount(c2);
    out.push({ name, status: "restricted", max_concentration: amount, conditions: cond });
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log(`▶ JP MHLW 化粧品基準 PDF 파싱 (${PDF_EN_PATH})...`);
  const text = await extractText();
  console.log(`  text length: ${text.length}`);

  const app1 = getSection(text, "Appendix 1", "Appendix 2");
  const app2 = getSection(text, "Appendix 2", "Appendix 3");
  const app3 = getSection(text, "Appendix 3", "Appendix 4");
  const app4 = getSection(text, "Appendix 4", "(*1)");

  // Appendix 2 §1/§2/§3 분리. 헤더 패턴은 "1. The ingredients restricted in all types",
  // "2. The ingredients restricted according to types or intended purposes",
  // "3. The ingredients restricted according to types of cosmetics".
  const app2sec1 = (() => {
    const a = app2.indexOf("1. The ingredients restricted in all types");
    const b = app2.indexOf("2. The ingredients restricted according to types");
    return a >= 0 && b > a ? app2.slice(a, b) : "";
  })();
  const app2sec2 = (() => {
    const a = app2.indexOf("2. The ingredients restricted according to types");
    const b = app2.indexOf("3. The ingredients restricted according to types");
    return a >= 0 && b > a ? app2.slice(a, b) : "";
  })();
  const app2sec3 = (() => {
    const a = app2.indexOf("3. The ingredients restricted according to types");
    return a >= 0 ? app2.slice(a) : "";
  })();

  const a1 = parseAppendix1(app1);
  const a2s1 = parseAmountTable(app2sec1, "JP MHLW 化粧品基準 別表 2 §1 (Appendix 2 §1 — restricted in all types)", "restricted");
  const a2s2 = parseAppendix2Section2(app2sec2);
  const a2s3 = parseAppendix2Section3(app2sec3);
  const a3 = parseAmountTable(app3, "JP MHLW 化粧品基準 別表 3 (Appendix 3 — preservatives positive list)", "listed");
  const a4 = parseAmountTable(app4, "JP MHLW 化粧品基準 別表 4 (Appendix 4 — UV absorbers positive list)", "listed");
  const items: ParsedItem[] = [...a1, ...a2s1, ...a2s2, ...a2s3, ...a3, ...a4];
  console.log(`  parsed: A1=${a1.length}, A2§1=${a2s1.length}, A2§2=${a2s2.length}, A2§3=${a2s3.length}, A3=${a3.length}, A4=${a4.length}, total ${items.length}`);

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInciLower = new Map<string, IngredientRow>();
  for (const i of ingredients) byInciLower.set(i.inci_name.toLowerCase(), i);

  const now = new Date().toISOString();
  const sourceVersion = `MHLW-${now.slice(0, 10)}`;
  const newRegs: RegulationRow[] = [];
  let matched = 0, created = 0;

  for (const it of items) {
    const key = it.name.toLowerCase();
    let ing = byInciLower.get(key);
    if (!ing) {
      ing = {
        id: randomUUID(),
        inci_name: it.name,
        korean_name: null,
        chinese_name: null,
        japanese_name: null,
        cas_no: null,
        synonyms: [],
        description: null,
        function_category: it.status === "listed" ? (it.conditions.includes("UV") ? "자외선차단제" : "보존제") : null,
        function_description: null,
      };
      ingredients.push(ing);
      byInciLower.set(key, ing);
      created++;
    } else {
      matched++;
    }

    newRegs.push({
      ingredient_id: ing.id,
      country_code: "JP",
      status: it.status,
      max_concentration: it.max_concentration,
      concentration_unit: it.max_concentration ? "g/100g" : "%",
      product_categories: [],
      conditions: it.conditions,
      source_url: SOURCE_URL,
      source_document: SOURCE_DOC,
      source_version: sourceVersion,
      source_priority: 100,
      last_verified_at: now,
      confidence_score: 1.0,
      override_note: null,
    });
  }
  console.log(`  matching: ${matched} matched, ${created} new`);

  const existingRegs = await readRows<RegulationRow>("regulations");
  const otherSources = existingRegs.filter((r) => r.source_document !== SOURCE_DOC);
  // F15: 소프트 파싱 실패(PDF 구조/Appendix 마커 변경 → items 0~소수) 시 기존 JP MHLW 데이터
  // 소실 방지. 결과가 기존의 50% 미만이면(기존 유의미 시) 중단.
  const prevJp = existingRegs.length - otherSources.length;
  if (prevJp > 50 && newRegs.length < prevJp * 0.5) {
    console.error(`✗ JP MHLW 파싱 결과 ${newRegs.length} 행 < 기존 ${prevJp} 의 50% — PDF 구조 변경 의심. 데이터 보존 위해 중단(write 안 함).`);
    process.exit(1);
  }
  const finalRegs = [...otherSources, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  console.log(`\n=== summary (${((Date.now()-startedAt)/1000).toFixed(1)}s) ===`);
  console.log(`  JP MHLW (Appendix 1 + 2§1/§2/§3 + 3 + 4): ${newRegs.length} rows (priority 100)`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
