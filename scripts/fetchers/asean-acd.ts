import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";
import { geminiRescue } from "../parsers/gemini-fallback";

// ASEAN Cosmetic Directive (ACD) — Annex II/III/IV/VI/VII PDF 자동 fetch + 정규식 파싱.
// 출처: aseancosmetics.org (ASEAN Cosmetic Association 공식). 매년 갱신.
//
// 한 번 받아 6국(VN/TH/ID/MY/PH/SG) 공통 fanout — ACD 가 ASEAN 공통 기준.
// 각국이 자체 법령으로 ACD 채택 → 6국 모두 1차 출처 (priority 100).
//
// Gemini 의존 0 — 정규식 직접 파싱. 매일 cron 안전 작동, 무료 tier 한도 영향 X.
// PDF SHA256 변경 시만 re-parse (변경 없으면 즉시 skip).

const SOURCE_PREFIX = "ASEAN Cosmetic Directive";
const ASEAN_COUNTRIES = ["VN", "TH", "ID", "MY", "PH", "SG"];
const FINGERPRINT_FILE = "public/data/asean-acd-fingerprints.json";

interface AnnexSpec {
  code: "II" | "III" | "IV" | "VI" | "VII";
  url: string;
  filename: string;
  status: "banned" | "restricted" | "listed";
  function_category: string | null;
  description: string;
}

const ANNEXES: AnnexSpec[] = [
  { code: "II",  url: "https://aseancosmetics.org/wp-content/uploads/2019/11/Annex-II_Release_29102019.pdf",
    filename: "asean_Annex-II_Release_29102019.pdf",
    status: "banned", function_category: null,
    description: "Annex II — Prohibited substances" },
  { code: "III", url: "https://aseancosmetics.org/wp-content/uploads/2019/11/Annex-III-Part-I_Release_29102019.pdf",
    filename: "asean_Annex-III-Part-I_Release_29102019.pdf",
    status: "restricted", function_category: null,
    description: "Annex III Part 1 — Restricted substances" },
  { code: "IV",  url: "https://aseancosmetics.org/wp-content/uploads/2019/11/Annex-IV-part-1-release-3-May-2018-201801.pdf",
    filename: "asean_Annex-IV-part-1-release-3-May-2018-201801.pdf",
    status: "listed", function_category: "색소",
    description: "Annex IV Part 1 — Allowed colorants (positive list)" },
  { code: "VI",  url: "https://aseancosmetics.org/wp-content/uploads/2019/11/Annex-VI-Part-1_Release_03102019.pdf",
    filename: "asean_Annex-VI-Part-1_Release_03102019.pdf",
    status: "listed", function_category: "보존제",
    description: "Annex VI Part 1 — Allowed preservatives (positive list)" },
  { code: "VII", url: "https://aseancosmetics.org/wp-content/uploads/2019/11/Annex-VII_Release_29102019.pdf",
    filename: "asean_Annex-VII_Release_29102019.pdf",
    status: "listed", function_category: "자외선차단제",
    description: "Annex VII — Permitted UV filters (positive list)" },
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

interface Fingerprint {
  [filename: string]: { sha256: string; parsed_at: string; entry_count: number };
}

interface Entry {
  inci: string;
  cas: string | null;
  ref: string | null;
  max_concentration: number | null;
  conditions: string | null;
}

async function downloadPdf(annex: AnnexSpec): Promise<Buffer> {
  const localPath = `public/data/raw-pdf/${annex.filename}`;
  // 매 cron run 마다 다시 다운 (PDF 변경 감지). 차단 시 기존 파일 fallback.
  try {
    const res = await fetch(annex.url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/125.0.0.0" },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(localPath, buf);
      return buf;
    }
  } catch (e) {
    console.warn(`  download failed: ${e instanceof Error ? e.message : e}`);
  }
  if (existsSync(localPath)) {
    console.log(`  using cached ${localPath}`);
    return readFileSync(localPath);
  }
  throw new Error(`${annex.code}: 다운로드 실패 + cache 없음`);
}

async function extractText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const r = await new PDFParse({ data: buf }).getText();
  return r.text;
}

// 텍스트 정리: 페이지 footer/header 제거.
function cleanText(text: string): string {
  return text
    .replace(/-- \d+ of \d+ --/g, " ")
    .replace(/Annex [IVX]+ (?:Part \d+ )?[–-][\s\S]{0,150}cosmetic\s*products?/gi, " ")
    .replace(/Version No\.[^\n]*/g, " ")
    .replace(/Release Version[^\n]*/g, " ")
    .replace(/ASEAN Cosmetic Documents\s*\d*/g, " ")
    .replace(/\s{3,}/g, " ");
}

// Annex II — Substance | CAS | Ref. 한 줄 또는 multi-line.
// Ref 패턴: A\d{4} (Annex II 기존) 또는 sequential 1, 2, 3...
function parseAnnexII(text: string): Entry[] {
  const out: Entry[] = [];
  // 헤더 직후부터 시작
  const headerIdx = text.search(/Substances?\s+CAS Number\s+Ref\.?\s+No/i);
  if (headerIdx < 0) return out;
  const body = text.slice(headerIdx).replace(/Substances?\s+CAS Number\s+Ref\.?\s+No/gi, " ");

  // ref 위치 모두 찾기 — 라인 끝 또는 공백 다음에 단독으로 나오는 A\d{4} 또는 1~9999
  const refRe = /\s(A\d{4}|\d{1,4})\s*(?=\n|$|\s+(?:Substances?|Annex|--))/g;
  // 더 단순: 라인 끝의 마지막 token 매칭
  const lines = body.split(/\r?\n/);
  // text 를 줄 join 후 ref 위치로 entries 분할
  const joined = lines.join(" ").replace(/\s+/g, " ");

  // ref 패턴 더 엄격: 앞에 공백, 뒤에 공백 또는 끝, A1136~ 또는 1~9999 (sequential)
  const refTokenRe = /\s(A\d{4}|\d{1,4})(?=\s|$)/g;
  const positions: { ref: string; pos: number; refStart: number }[] = [];
  let m;
  while ((m = refTokenRe.exec(joined))) {
    const ref = m[1];
    const refStart = m.index + 1;
    // sequential ref 만 허용 — 1~9999, 또는 A1136~A9999
    const num = ref.startsWith("A") ? Number(ref.slice(1)) : Number(ref);
    if (ref.startsWith("A") && (num < 1000 || num > 9999)) continue;
    if (!ref.startsWith("A") && (num < 1 || num > 9999)) continue;
    positions.push({ ref, pos: m.index, refStart });
  }

  // sequential filter — A1136 sequence + 1, 2, 3... sequence
  // 두 sequence 가 섞임. 각각 분리해서 sequential 검증
  const seqA = positions.filter((p) => p.ref.startsWith("A"));
  const seqN = positions.filter((p) => !p.ref.startsWith("A"));

  function validateSequence(ps: typeof positions, prefix: "A" | ""): typeof positions {
    const valid: typeof positions = [];
    let lastNum = -1;
    for (const p of ps) {
      const num = Number(p.ref.replace(prefix, ""));
      // 시작점: lastNum=-1 일 때 첫 항목 허용
      // 그 후 += 1 또는 ±5 이내 점프 허용 (PDF noise tolerance)
      if (lastNum < 0) {
        if (prefix === "A" && num >= 1100 && num <= 1200) { valid.push(p); lastNum = num; }
        else if (prefix === "" && num === 1) { valid.push(p); lastNum = num; }
      } else if (num === lastNum + 1 || (num > lastNum && num - lastNum <= 3)) {
        valid.push(p); lastNum = num;
      }
    }
    return valid;
  }
  const validA = validateSequence(seqA, "A");
  const validN = validateSequence(seqN, "");
  const allValid = [...validA, ...validN].sort((a, b) => a.pos - b.pos);

  // 각 valid ref 의 영역 = 이전 ref 끝 ~ 현재 ref 시작
  let prevEnd = 0;
  for (const p of allValid) {
    const block = joined.slice(prevEnd, p.pos).trim();
    prevEnd = p.refStart + p.ref.length;
    if (!block) continue;
    // CAS 추출 — NNN-NN-N 또는 multiple slash 묶음
    const casMatches = [...block.matchAll(/(\d{1,7}-\d{2,4}-\d)/g)];
    const cas = casMatches[0]?.[1] ?? null;
    // substance = block 에서 CAS 제거 + 후처리
    let substance = block;
    for (const cm of casMatches) substance = substance.replace(cm[1], " ");
    substance = substance
      .replace(/\b\/\b/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[-–—\s]+|[-–—\s]+$/g, "")
      .trim();
    // 너무 짧거나 너무 긴 것 skip
    if (!substance || substance.length < 3 || substance.length > 400) continue;
    // 영문 letter 비율 체크 (garbage 거부)
    const letters = (substance.match(/[A-Za-z]/g) ?? []).length;
    if (letters < 5) continue;
    out.push({ inci: substance, cas, ref: p.ref, max_concentration: null, conditions: null });
  }
  return out;
}

// Annex III/VI/VII — multi-row 표. ref 가 라인 시작에 (1, 1a, 2, ...) + 공백 + 본문.
// 두 ref 사이가 한 entry 영역.
function parseRefBasedAnnex(text: string, headerPattern: RegExp): Entry[] {
  const out: Entry[] = [];
  const headerIdx = text.search(headerPattern);
  if (headerIdx < 0) return out;
  const body = text.slice(headerIdx);
  // ref 패턴: 라인 시작 + 1~3자리 숫자 (+ 옵션 a/b/c) + 공백 또는 줄바꿈
  const refRe = /(?:^|\n)\s*(\d{1,3}[a-z]?)(?=\s|$)/g;
  const positions: { ref: string; pos: number }[] = [];
  let m;
  while ((m = refRe.exec(body))) {
    positions.push({ ref: m[1], pos: m.index + (m[0].length - m[1].length) });
  }
  // sequential validation — Annex III/VI/VII 모두 monotonic 증가 (단 Annex III 는
  // 큰 gap 있음, e.g. 1→8→95→102). 따라서 strict gap≤3 대신 monotonic 만 요구.
  const valid: { ref: string; pos: number }[] = [];
  let lastBaseNum = -1;
  for (const p of positions) {
    const baseNum = Number(p.ref.replace(/[a-z]$/, ""));
    if (baseNum < 1 || baseNum > 999) continue;
    // 첫 ref 는 1 또는 작은 숫자에서 시작
    if (lastBaseNum === -1) {
      if (baseNum <= 5) { valid.push(p); lastBaseNum = baseNum; }
      continue;
    }
    // 같은 baseNum 의 letter variant (e.g. 1a 다음 1b) 또는 monotonic 증가
    if (baseNum === lastBaseNum || baseNum > lastBaseNum) {
      valid.push(p); lastBaseNum = baseNum;
    }
  }
  for (let i = 0; i < valid.length; i++) {
    const cur = valid[i];
    const next = valid[i + 1];
    const block = body.slice(cur.pos + cur.ref.length, next?.pos ?? body.length).slice(0, 1500);
    const casMatches = [...block.matchAll(/(\d{1,7}-\d{2,4}-\d)/g)];
    const cas = casMatches[0]?.[1] ?? null;
    // substance = block 시작부터 CAS 또는 첫 큰 break (줄바꿈 2회) 까지
    let substanceEnd = casMatches[0]?.index ?? -1;
    if (substanceEnd < 0) {
      // CAS 없으면 첫 250 chars 까지
      substanceEnd = Math.min(250, block.length);
    }
    const substance = block.slice(0, substanceEnd)
      .replace(/CAS No\.?/gi, " ")
      .replace(/\(\s*CAS\s*\)/gi, " ")
      .replace(/See also \d+[a-z]?/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    // 첫 (와 ) 사이 footnote 제거 시 substance 의미 손실 가능 — 보존
    if (!substance || substance.length < 3 || substance.length > 300) continue;
    const letters = (substance.match(/[A-Za-z]/g) ?? []).length;
    if (letters < 5) continue;
    // % 농도 추출
    const concM = block.match(/(\d+(?:\.\d+)?)\s*%/);
    const maxConc = concM ? Number(concM[1]) : null;
    const conditions = block.replace(/\s+/g, " ").trim().slice(0, 500);
    out.push({ inci: substance, cas, ref: cur.ref, max_concentration: maxConc, conditions });
  }
  return out;
}

// Annex IV (Colorants positive list) — CI 번호 5자리 + 색깔 + field of application.
// 패턴: `<5자리CI> [(footnote)] <Color> [X X X X] [other limitations]`
function parseAnnexIV(text: string): Entry[] {
  const out: Entry[] = [];
  const colors = "Green|Yellow|Orange|Red|Brown|Black|Blue|Violet|White";
  const re = new RegExp(
    `(?:^|\\n)\\s*(\\d{5})\\s*(?:\\(\\d+\\))?\\s+(${colors})\\b([^\\n]{0,200})`,
    "gim",
  );
  let m;
  const seen = new Set<string>();
  while ((m = re.exec(text))) {
    const ci = m[1];
    if (seen.has(ci)) continue;
    seen.add(ci);
    const color = m[2];
    const tail = m[3] ?? "";
    const concM = tail.match(/(\d+(?:\.\d+)?)\s*%/);
    const conditions = `Color: ${color}.${tail.trim() ? ` ${tail.replace(/\s+/g, " ").trim().slice(0, 250)}` : ""}`;
    out.push({
      inci: `CI ${ci}`,
      cas: null,
      ref: ci,
      max_concentration: concM ? Number(concM[1]) : null,
      conditions,
    });
  }
  return out;
}

function parseAnnex(text: string, code: AnnexSpec["code"]): Entry[] {
  const cleaned = cleanText(text);
  if (code === "II") return parseAnnexII(cleaned);
  if (code === "III") return parseRefBasedAnnex(cleaned, /Ref No[\s\S]{0,200}Substance/i);
  if (code === "IV") return parseAnnexIV(cleaned);
  if (code === "VI") return parseRefBasedAnnex(cleaned, /Reference[\s\S]{0,150}Substance/i);
  if (code === "VII") return parseRefBasedAnnex(cleaned, /Reference[\s\S]{0,150}Substance|UV filters/i);
  return [];
}

async function main() {
  const startedAt = Date.now();
  const fingerprints: Fingerprint = existsSync(FINGERPRINT_FILE)
    ? JSON.parse(readFileSync(FINGERPRINT_FILE, "utf8"))
    : {};

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInci = new Map<string, IngredientRow>();
  const byCas = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    byInci.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) byCas.set(i.cas_no, i);
  }

  const now = new Date().toISOString();
  const newRegs: RegulationRow[] = [];
  const sourceDocsToReplace = new Set<string>();
  let totalProcessed = 0, totalSkipped = 0, totalEntries = 0, totalCreated = 0;

  for (const annex of ANNEXES) {
    console.log(`\n▶ ASEAN ACD ${annex.description}`);
    let buf: Buffer;
    try {
      buf = await downloadPdf(annex);
    } catch (e) {
      console.warn(`  ✗ ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    const fp = fingerprints[annex.filename];
    if (fp && fp.sha256 === sha && fp.entry_count > 0) {
      console.log(`  · 변경 없음 (sha 동일) — skip parsing. 이전 entry ${fp.entry_count}건 보존.`);
      totalSkipped++;
      // 기존 source_document 의 row 는 그대로 유지 (sourceDocsToReplace 에 추가 안 함)
      continue;
    }
    const text = await extractText(buf);
    let entries = parseAnnex(text, annex.code);
    console.log(`  ${(text.length / 1024).toFixed(0)}KB text → ${entries.length} entries`);
    if (entries.length === 0) {
      // 0건 = 이 Annex PDF 양식 변경 신호 → buf 를 임시 PDF 로 써서 Gemini 폴백 1회.
      // 정상(>0)이면 이 분기 미실행 → 기존 동작과 100% 동일(부작용 0).
      const tmp = join(tmpdir(), `asean-${annex.code}-${process.pid}.pdf`);
      writeFileSync(tmp, buf);
      const rescued = await geminiRescue({ filePath: tmp, country: "ASEAN", title: annex.description, url: annex.url });
      try { unlinkSync(tmp); } catch { /* temp 정리 실패 무시 */ }
      const fbEntries: Entry[] = rescued
        .filter((r) => r.status !== "not_listed")
        .map((r) => ({
          inci: r.inci_name,
          cas: r.cas_no,
          ref: null,
          max_concentration: r.max_concentration,
          conditions: (r.conditions ? r.conditions + " " : "") + "(정규식 0건 → Gemini 폴백)",
        }));
      if (fbEntries.length === 0) {
        console.warn(`  ! 0 entries + Gemini 폴백 0건 — fingerprint 미저장.`);
        continue;
      }
      console.log(`  ⚠ 정규식 0건 → Gemini 폴백 ${fbEntries.length}건`);
      entries = fbEntries;
    }

    const sourceDoc = `${SOURCE_PREFIX} — ${annex.description}`;
    sourceDocsToReplace.add(sourceDoc);
    let created = 0;
    for (const e of entries) {
      const inci = e.inci.trim();
      let ing = byInci.get(inci.toLowerCase());
      if (!ing && e.cas) ing = byCas.get(e.cas);
      if (!ing) {
        ing = {
          id: randomUUID(), inci_name: inci,
          korean_name: null, chinese_name: null, japanese_name: null,
          cas_no: e.cas, synonyms: [], description: null,
          function_category: annex.function_category, function_description: null,
        };
        ingredients.push(ing);
        byInci.set(inci.toLowerCase(), ing);
        if (e.cas) byCas.set(e.cas, ing);
        created++;
      } else if (!ing.cas_no && e.cas) {
        ing.cas_no = e.cas;
      }
      const conditionsText = [
        `${annex.description} 등재.`,
        e.ref ? `Ref No: ${e.ref}` : null,
        e.cas ? `CAS: ${e.cas}` : null,
        e.conditions ? `조건: ${e.conditions.slice(0, 400)}` : null,
        `ASEAN 6국(VN/TH/ID/MY/PH/SG) 공통 채택.`,
      ].filter(Boolean).join("\n");
      for (const cc of ASEAN_COUNTRIES) {
        newRegs.push({
          ingredient_id: ing.id, country_code: cc, status: annex.status,
          max_concentration: e.max_concentration, concentration_unit: "%",
          product_categories: annex.function_category ? [annex.function_category] : [],
          conditions: conditionsText,
          source_url: annex.url, source_document: sourceDoc,
          source_version: `ACD-${annex.code}-${annex.url.match(/\d{8}/)?.[0] ?? "2019"}`,
          source_priority: 100, last_verified_at: now,
          confidence_score: 1.0, override_note: null,
        });
      }
    }
    totalEntries += entries.length;
    totalCreated += created;
    totalProcessed++;
    // fingerprint 저장 — parser 가 충분히 추출했을 때만. 부족하면 다음 cron 재시도.
    // (각 Annex 별 expected min: II=1000, III=100, IV=100, VI=50, VII=25)
    const EXPECTED_MIN: Record<string, number> = { II: 1000, III: 100, IV: 100, VI: 50, VII: 25 };
    const minOk = entries.length >= (EXPECTED_MIN[annex.code] ?? 30);
    if (minOk) {
      fingerprints[annex.filename] = { sha256: sha, parsed_at: now, entry_count: entries.length };
    } else {
      console.log(`  ! entries 부족 (${entries.length} < ${EXPECTED_MIN[annex.code]}) — fingerprint 미저장, 다음 cron 재시도`);
    }
  }

  // 머지 — sourceDocsToReplace 의 source_document 만 제거 후 새로 insert
  const existingRegs = await readRows<RegulationRow>("regulations");
  const filteredRegs = existingRegs.filter((r) => !sourceDocsToReplace.has(r.source_document));
  const finalRegs = [...filteredRegs, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });
  writeFileSync(FINGERPRINT_FILE, JSON.stringify(fingerprints, null, 2));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  처리 ${totalProcessed} Annex / skip ${totalSkipped} (변경 없음)`);
  console.log(`  entries: ${totalEntries} (new ingredients ${totalCreated})`);
  console.log(`  6국 fanout: ${newRegs.length} regulations`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
