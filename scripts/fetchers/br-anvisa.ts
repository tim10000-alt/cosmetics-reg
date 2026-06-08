import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";
import { geminiRescue } from "../parsers/gemini-fallback";

// BR ANVISA RDC PDF 자동 fetch + 정규식 파싱.
// 출처: KCIA 15087 첨부 zip (브라질 규정 원문 모음 — KCIA 가 자동 다운로드).
// kcia-articles.ts cron 이 zip 다운, br-anvisa.ts cron 이 unzip + parse.
//
// 핵심 RDC (BR 1차 출처, priority 100):
//   RDC 83/2016 — 배합금지 성분 (banned, MERCOSUL 62/2014)
//   RDC 03/2012 — 배합한도 제한 (restricted, MERCOSUL 24/2011)
//   RDC 29/2012 — 허용 보존제 (preservatives positive)
//   RDC 628/2022 — 허용 색소 (colorants positive, 최신)
//   RDC 600/2022 — 허용 UV 필터 (UV positive, 최신)
//
// Gemini 의존 0 — 정규식 직접. 매일 cron 안전 작동.

const SOURCE_PREFIX = "ANVISA Brazil";
const KCIA_ATTACH_DIR = "public/data/raw-attach/kcia-15087";
const ZIP_FILE = `${KCIA_ATTACH_DIR}/브라질 규정 원문, 국문번역본 모음(2023년)홈피게시.zip`;
const UNZIP_DIR = `${KCIA_ATTACH_DIR}/br-rdc`;
const FINGERPRINT_FILE = "public/data/br-anvisa-fingerprints.json";

interface RdcSpec {
  filename: string;
  status: "banned" | "restricted" | "listed";
  function_category: string | null;
  description: string;
  parser: "ref-cas" | "positive-list" | "color-index" | "hair-active" | "hand-list";
  // Mercosul 결의 채택분 — BR ANVISA RDC = AR ANMAT Disposición 동일 list.
  // BR 만 채택한 것은 ["BR"], Mercosul 공통은 ["BR", "AR"].
  countries: string[];
  mercosul_basis: string | null;
  // hand-list parser 가 사용할 entries (RDC 645 등 4개 substance hardcode 케이스).
  hand_list?: { inci: string; cas: string; status: "banned" | "restricted"; conditions: string }[];
}

const RDCS: RdcSpec[] = [
  { filename: "RDC_83_2016 (배합금지 성분 목록).pdf",
    status: "banned", function_category: null,
    description: "RDC 83/2016 — 배합금지 성분 목록",
    parser: "ref-cas",
    countries: ["BR", "AR"],
    mercosul_basis: "MERCOSUL GMC 62/2014" },
  { filename: "RDC_03_2012 (배합한도 제한 성분 목록).pdf",
    status: "restricted", function_category: null,
    description: "RDC 03/2012 — 배합한도 제한 성분 목록",
    parser: "ref-cas",
    countries: ["BR", "AR"],
    mercosul_basis: "MERCOSUL GMC 24/2011" },
  { filename: "RDC_29_2012 (허용 보존제 목록).pdf",
    status: "listed", function_category: "보존제",
    description: "RDC 29/2012 — 허용 보존제 목록 (positive list)",
    parser: "positive-list",
    countries: ["BR", "AR"],
    mercosul_basis: "MERCOSUL GMC 23/2011" },
  { filename: "RDC_628_2022 (개인위생 제품, 화장품 및 향수의 허용 착색물질 목록).pdf",
    status: "listed", function_category: "색소",
    description: "RDC 628/2022 — 허용 착색물질 (positive list)",
    parser: "color-index",
    countries: ["BR", "AR"],
    mercosul_basis: "MERCOSUL GMC 16/2012" },
  { filename: "RDC_600_2022 (개인 위생용품, 화장품 및 향수 제품에 허용되는 자외선 필터 목록).pdf",
    status: "listed", function_category: "자외선차단제",
    description: "RDC 600/2022 — 허용 자외선 필터 목록 (positive list)",
    parser: "positive-list",
    countries: ["BR"],
    mercosul_basis: null },
  // IN 220/2023 — hair straightener/wave active 허용 list. ANVISA Instrução Normativa.
  // 표 형식: Nº | 포르투갈어 이름 | INCI (대문자, 콤마 구분) | 농도 | 경고 | 기타.
  { filename: "RDC_220_2023 (헤어 스트레이트 또는 웨이브용 화장품에 허용되는 활성제 목록).pdf",
    status: "listed", function_category: "헤어 스트레이트너",
    description: "IN 220/2023 — 헤어 스트레이트/웨이브 허용 활성제 (positive list)",
    parser: "hair-active",
    countries: ["BR"],
    mercosul_basis: null },
  // RDC 645/2022 — 4 substances 사용 조건 (Mercosul GMC 48/2010).
  { filename: "RDC_645_2022 (납, 아세테이트, 포름알데히드, 파라포름알데히드 및 피로갈롤의 사용 조건).pdf",
    status: "restricted", function_category: null,
    description: "RDC 645/2022 — 납·포름알데히드·피로갈롤 사용 조건",
    parser: "hand-list",
    countries: ["BR", "AR"],
    mercosul_basis: "MERCOSUL GMC 48/2010",
    hand_list: [
      { inci: "Lead acetate", cas: "301-04-2", status: "banned",
        conditions: "RDC 645/2022 — 화장품 사용 금지. 헤어다이 carbon-based progressive hair colour 등 모든 화장품 적용." },
      { inci: "Formaldehyde", cas: "50-00-0", status: "restricted",
        conditions: "RDC 645/2022 — 0.2% 한도 (총 free formaldehyde). nail hardener 5%. spray 에어로졸 사용 금지." },
      { inci: "Paraformaldehyde", cas: "30525-89-4", status: "restricted",
        conditions: "RDC 645/2022 — formaldehyde 와 동일 사용 조건 (0.2% 한도). spray 에어로졸 사용 금지." },
      { inci: "Pyrogallol", cas: "87-66-1", status: "banned",
        conditions: "RDC 645/2022 — 화장품 사용 금지. 2023-06-30 까지 RDC 15/2013 기준 등록 제품 sell-through 허용." },
    ] },
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

interface Fingerprint { [filename: string]: { sha256: string; parsed_at: string; entry_count: number } }

interface Entry {
  inci: string;
  cas: string | null;
  ref: string | null;
  max_concentration: number | null;
  conditions: string | null;
  status?: "banned" | "restricted" | "listed";   // hand-list 에서 entry 별 override
}

async function ensureUnzipped(): Promise<void> {
  // 한 번 unzip 후 cache. zip SHA 변경 시 재unzip.
  if (!existsSync(ZIP_FILE)) throw new Error(`zip 부재: ${ZIP_FILE} — kcia:articles 먼저 실행`);
  if (!existsSync(UNZIP_DIR)) mkdirSync(UNZIP_DIR, { recursive: true });
  // 첫 RDC PDF 가 없으면 unzip 실행
  const probeFile = `${UNZIP_DIR}/${RDCS[0].filename}`;
  if (existsSync(probeFile)) return;
  console.log(`▶ unzip ${ZIP_FILE} → ${UNZIP_DIR}`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn("unzip", ["-o", ZIP_FILE, "-d", UNZIP_DIR], { stdio: "inherit" });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`unzip exit ${code}`)));
  });
}

async function extractText(filename: string): Promise<string> {
  const buf = readFileSync(`${UNZIP_DIR}/${filename}`);
  const { PDFParse } = await import("pdf-parse");
  const r = await new PDFParse({ data: buf }).getText();
  return r.text;
}

function cleanText(text: string): string {
  return text
    .replace(/Ministério da Saúde - MS/g, " ")
    .replace(/Agência Nacional de Vigilância Sanitária - ANVISA/g, " ")
    .replace(/Este texto não substitui[^\n]*/g, " ")
    .replace(/-- \d+ of \d+ --/g, " ")
    .replace(/\s{3,}/g, " ");
}

// RDC 83/03 — "N° N°UE Substância CAS NUMERO EINECS" 표.
// 패턴: 라인 시작 + ref(\d{1,4}) + 공백 + (옵션 EU ref) + substance + CAS + EINECS.
// CAS 패턴 명확하므로 ref 기반 분할.
function parseRefCas(text: string): Entry[] {
  const out: Entry[] = [];
  const cleaned = cleanText(text);
  // ref 위치 — 라인 시작 또는 공백 다음 1~4자리 숫자, 다음에 공백+같은 숫자(EU ref) 또는 공백+텍스트
  // 단순화: substance + CAS 패턴 매칭. 각 entry 가 CAS 한 번 들어 있음.
  // CAS 위치 모두 찾기 → 각 CAS 주변 영역이 한 entry.
  const casRe = /(\d{1,7}-\d{2,4}-\d)/g;
  const casPositions: { cas: string; pos: number }[] = [];
  let m;
  while ((m = casRe.exec(cleaned))) {
    casPositions.push({ cas: m[1], pos: m.index });
  }
  if (casPositions.length === 0) return out;
  // 각 CAS 의 직전 텍스트 = substance. 직전 다른 CAS 위치 또는 ref 패턴 직후가 substance 시작.
  for (let i = 0; i < casPositions.length; i++) {
    const cur = casPositions[i];
    const start = i > 0 ? casPositions[i - 1].pos + casPositions[i - 1].cas.length : 0;
    const block = cleaned.slice(start, cur.pos);
    // ref 추출 (라인 시작 또는 공백 다음 1-4자리 숫자가 두 번 연속 또는 한 번)
    const refM = block.match(/(?:^|\s)(\d{1,4})(?:\s+\d{1,4})?\s+(?=\S)/);
    const ref = refM?.[1] ?? null;
    let substance = (refM ? block.slice((refM.index ?? 0) + refM[0].length) : block)
      .replace(/\s+/g, " ")
      .trim();
    // EINECS 번호 (NNN-NNN-N) 제거
    substance = substance.replace(/\b\d{3}-\d{3}-\d\b/g, " ").replace(/\s+/g, " ").trim();
    if (!substance || substance.length < 3 || substance.length > 400) continue;
    const letters = (substance.match(/[A-Za-z]/g) ?? []).length;
    if (letters < 4) continue;
    out.push({ inci: substance, cas: cur.cas, ref, max_concentration: null, conditions: null });
  }
  // dedupe by (inci lower, cas)
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.inci.toLowerCase()}|${e.cas}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// RDC 29/628/600 — positive list 표.
// 형식: `Nº ORD <number>\n` 헤더 + 다중 라인 substance description (포르투갈어 + INCI in parens) +
//   `X.X%` 또는 `(número CAS NN-NN-N)` 등의 메타.
// INCI 추출: 대문자만 있는 라인 또는 `(INCI_UPPER, INCI_UPPER)` 패턴 (포르투갈어 이름은 lowercase 시작).
function parsePositiveList(text: string): Entry[] {
  const out: Entry[] = [];
  const cleaned = cleanText(text);
  const lines = cleaned.split(/\r?\n/);

  // entry 분할: 라인 단독 숫자 (Nº ORD 헤더) — 이 다음부터 다음 단독 숫자까지가 한 entry.
  // 헤더 lines (Nº/ORD/SUBSTÂNCIA/MÁXIMA 등) skip.
  const isHeaderLine = (s: string) =>
    /^(Nº|ORD|N[°º]\s*ORD|SUBST[ÂA]NCIA|M[ÁA]XIMA|CONCENTRA[ÇC][ÃA]O|AUTORIZADA|LIMITA[ÇC][ÕO]ES|CONDI[ÇC][ÕO]ES|USO|ADVERT[ÊE]NCIAS|LISTA DE|REGULAMENTO|Para os efeitos|ANEXO|ADENDO|^\d+\s+(of|de)\s+\d+)/i.test(s);

  type Block = { ord: number; bodyLines: string[] };
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    // ord header: 라인 단독 숫자
    const ordM = t.match(/^(\d{1,4})$/);
    if (ordM) {
      const n = Number(ordM[1]);
      // 합리적 범위 (RDC 29: 1~50, RDC 628: 1~200, RDC 600: 1~50)
      if (n >= 1 && n <= 999) {
        if (cur) blocks.push(cur);
        cur = { ord: n, bodyLines: [] };
        continue;
      }
    }
    if (!cur) continue;
    if (isHeaderLine(t)) continue;
    cur.bodyLines.push(t);
  }
  if (cur) blocks.push(cur);

  for (const b of blocks) {
    const body = b.bodyLines.join(" ").replace(/\s+/g, " ");
    if (body.length < 5) continue;
    // INCI 추출 — 괄호 안 대문자 표기. e.g. (BENZOIC ACID, SODIUM BENZOATE) 또는 (SALICYLIC ACID & salts).
    const inciM = body.match(/\(([A-Z][A-Z0-9\s,'\-&./]+(?:&[\s\w]+)?)\)/);
    let inci: string | null = null;
    if (inciM) {
      // 첫 substance 이름 추출 (콤마/& 전까지)
      inci = inciM[1].split(/,\s*|\s+&\s+/)[0].trim();
      // 너무 짧거나 noisy — skip
      if (inci.length < 3) inci = null;
    }
    // INCI 없으면 첫 라인의 포르투갈어 이름 사용
    if (!inci) {
      const firstLine = b.bodyLines[0]?.trim() ?? "";
      // 포르투갈어 이름 first segment (괄호 전)
      const ptName = firstLine.split("(")[0].trim();
      if (ptName.length >= 3 && ptName.length <= 200) inci = ptName;
    }
    if (!inci) continue;
    // 길이/letter 검증
    if (inci.length < 3 || inci.length > 200) continue;
    const letters = (inci.match(/[A-Za-z]/g) ?? []).length;
    if (letters < 3) continue;

    // CAS 추출
    const casM = body.match(/(\d{1,7}-\d{2,4}-\d)/);
    const cas = casM ? casM[1] : null;
    // max conc 추출 — 첫 % 패턴
    const concM = body.match(/(\d+(?:[,.]\d+)?)\s*%/);
    const maxConc = concM ? Number(concM[1].replace(",", ".")) : null;

    out.push({
      inci,
      cas,
      ref: String(b.ord),
      max_concentration: maxConc,
      conditions: null,
    });
  }
  // dedupe by (inci lower, cas)
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.inci.toLowerCase()}|${e.cas ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// IN 220/2023 — 헤어 스트레이트/웨이브 활성제 positive list. INCI 가 별도 열에 대문자.
// 형식: Nº (1-N) + 포르투갈어 이름 + INCI list (콤마 구분 대문자) + 농도 + 경고 + 기타.
// 각 row 의 INCI list 를 split → 각 INCI 별 entry 발급. 농도 추출.
function parseHairActive(text: string): Entry[] {
  const out: Entry[] = [];
  const cleaned = cleanText(text);
  const lines = cleaned.split(/\r?\n/);
  // header 식별: ANEXO + LISTA DE ATIVOS 까지 skip
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/LISTA DE ATIVOS PERMITIDOS/i.test(lines[i])) { bodyStart = i; break; }
  }
  const body = lines.slice(bodyStart).join("\n");
  // ord block split — Nº 라인 단독 1, 2, 3, ... (RDC 220 entries 약 5-10).
  const ordRe = /(?:^|\n)\s*(\d{1,3})\s*(?=\n)/g;
  const positions: { ord: number; pos: number }[] = [];
  let m;
  while ((m = ordRe.exec(body))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 99) positions.push({ ord: n, pos: m.index + (m[0].length - String(n).length) });
  }
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const next = positions[i + 1];
    const block = body.slice(cur.pos, next?.pos ?? body.length);
    // INCI 추출 — uppercase substring (16+ chars 영문 + 공백/콤마/&)
    const inciSect = block.match(/([A-Z][A-Z0-9\s,&\-/.]{15,})/g);
    if (!inciSect) continue;
    // 가장 긴 uppercase 영역이 INCI list
    const longest = inciSect.reduce((a, b) => (b.length > a.length ? b : a), "");
    const inciTokens = longest
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 4 && t.length <= 100 && /[A-Z]/.test(t));
    if (inciTokens.length === 0) continue;
    // 농도 — 첫 % 또는 pH
    const concM = block.match(/(\d+(?:[,.]\d+)?)\s*%/);
    const maxConc = concM ? Number(concM[1].replace(",", ".")) : null;
    for (const inci of inciTokens) {
      out.push({ inci, cas: null, ref: String(cur.ord), max_concentration: maxConc, conditions: null });
    }
  }
  // dedupe
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = e.inci.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// RDC 628 — Color Index 5-digit + 색상명(PT) + 컬럼 마커. INCI 포맷: "CI NNNNN".
function parseColorIndex(text: string): Entry[] {
  const out: Entry[] = [];
  const cleaned = cleanText(text);
  // 5자리 CI + COLOR_NAME(PT) + X 마커 패턴. 같은 라인 또는 다음 라인.
  const re = /\b(\d{5})\s+(VERDE|AMARELO|LARANJA|VERMELHO|MARROM|VIOLETA|AZUL|MARRON|NEGRO|PRETO|BRANCO|ROSA|CINZA)\b/g;
  let m;
  const seen = new Set<string>();
  while ((m = re.exec(cleaned))) {
    const ci = m[1];
    if (seen.has(ci)) continue;
    seen.add(ci);
    // 농도 추출 — 같은 line 또는 다음 100자 내 "máxima ... X%"
    const after = cleaned.slice(m.index, m.index + 200);
    const concM = after.match(/(\d+(?:[,.]\d+)?)\s*%/);
    out.push({
      inci: `CI ${ci}`,
      cas: null,
      ref: ci,
      max_concentration: concM ? Number(concM[1].replace(",", ".")) : null,
      conditions: null,
    });
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  await ensureUnzipped();

  const fingerprints: Fingerprint = existsSync(FINGERPRINT_FILE)
    ? JSON.parse(readFileSync(FINGERPRINT_FILE, "utf8"))
    : {};

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInci = new Map<string, IngredientRow>();
  const byCas = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    byInci.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) { byCas.set(i.cas_no, i); for (const c of i.cas_no.split(/[\s,;]+/)) { const t = c.trim(); if (t && t !== i.cas_no) byCas.set(t, i); } }  // 다중 CAS 토큰별 키 추가(분절 방지·전체문자열 키 유지=무회귀)
  }

  const now = new Date().toISOString();
  const newRegs: RegulationRow[] = [];
  const sourceDocsToReplace = new Set<string>();
  let totalProcessed = 0, totalSkipped = 0, totalEntries = 0, totalCreated = 0;

  for (const rdc of RDCS) {
    console.log(`\n▶ ${rdc.description}`);
    const path = `${UNZIP_DIR}/${rdc.filename}`;
    if (!existsSync(path)) {
      console.warn(`  ✗ 파일 부재: ${path}`);
      continue;
    }
    const buf = readFileSync(path);
    const sha = createHash("sha256").update(buf).digest("hex");
    const fp = fingerprints[rdc.filename];
    if (fp && fp.sha256 === sha && fp.entry_count > 0) {
      console.log(`  · 변경 없음 — skip. 이전 entry ${fp.entry_count}.`);
      totalSkipped++;
      continue;
    }
    let entries: Entry[];
    let textLen = 0;
    if (rdc.parser === "hand-list") {
      entries = (rdc.hand_list ?? []).map((h) => ({
        inci: h.inci, cas: h.cas, ref: null, max_concentration: null,
        conditions: h.conditions, status: h.status,
      }));
    } else {
      const text = await extractText(rdc.filename);
      textLen = text.length;
      entries =
        rdc.parser === "ref-cas" ? parseRefCas(text) :
        rdc.parser === "color-index" ? parseColorIndex(text) :
        rdc.parser === "hair-active" ? parseHairActive(text) :
        parsePositiveList(text);
    }
    console.log(`  ${textLen ? (textLen / 1024).toFixed(0) + "KB text → " : ""}${entries.length} entries`);
    // hand-list 는 항상 처리 (적은 entries 도 valid). 그 외는 너무 적으면 skip.
    if (rdc.parser !== "hand-list" && entries.length < 5) {
      // 정규식 <5 = 이 RDC PDF 양식 변경 신호 → 해당 PDF 1건만 Gemini 폴백(무료 throttle).
      // 정상(≥5)이면 이 분기 미실행 → 기존 동작과 100% 동일(부작용 0).
      const rescued = await geminiRescue({ filePath: path, country: "BR", title: rdc.description, url: "https://kcia.or.kr/home/law/law_05.php?type=view&no=15087" });
      const fbEntries: Entry[] = rescued
        .filter((r) => r.status !== "not_listed")
        .map((r) => ({
          inci: r.inci_name,
          cas: r.cas_no,
          ref: null,
          max_concentration: r.max_concentration,
          conditions: (r.conditions ? r.conditions + " " : "") + "(정규식 0건 → Gemini 폴백)",
          status: r.status === "banned" ? "banned" : r.status === "restricted" ? "restricted" : "listed",
        }));
      if (fbEntries.length === 0) {
        console.warn(`  ! 너무 적음(${entries.length}) + Gemini 폴백 0건 — fingerprint 미저장`);
        continue;
      }
      console.log(`  ⚠ 정규식 ${entries.length}건(<5) → Gemini 폴백 ${fbEntries.length}건`);
      entries = fbEntries;
    }

    const rdcId = rdc.description.match(/RDC \d+\/\d{4}/)?.[0] ?? rdc.description;
    const brSourceDoc = `${SOURCE_PREFIX} — ${rdc.description}`;
    sourceDocsToReplace.add(brSourceDoc);
    const arSourceDoc = rdc.mercosul_basis
      ? `ANMAT Argentina — ${rdc.mercosul_basis} (BR ANVISA ${rdcId} 동일 채택)`
      : null;
    if (arSourceDoc) sourceDocsToReplace.add(arSourceDoc);
    let created = 0;
    for (const e of entries) {
      let ing = byInci.get(e.inci.toLowerCase());
      if (!ing && e.cas) ing = byCas.get(e.cas);
      if (!ing) {
        ing = {
          id: randomUUID(), inci_name: e.inci,
          korean_name: null, chinese_name: null, japanese_name: null,
          cas_no: e.cas, synonyms: [], description: null,
          function_category: rdc.function_category, function_description: null,
        };
        ingredients.push(ing);
        byInci.set(e.inci.toLowerCase(), ing);
        if (e.cas) byCas.set(e.cas, ing);
        created++;
      } else if (!ing.cas_no && e.cas) ing.cas_no = e.cas;
      for (const cc of rdc.countries) {
        const isMercosulFanout = cc !== "BR" && rdc.mercosul_basis !== null;
        const conditionsText = [
          `${rdc.description} 등재.`,
          isMercosulFanout
            ? `Mercosul 결의 ${rdc.mercosul_basis} — Argentina ANMAT 동일 채택.`
            : (rdc.mercosul_basis ? `Mercosul 결의 ${rdc.mercosul_basis} 채택.` : null),
          e.conditions ?? null,
          e.ref ? `Ref: ${e.ref}` : null,
          e.cas ? `CAS: ${e.cas}` : null,
          `출처: KCIA 15087 첨부(브라질 규정 원문 zip).`,
        ].filter(Boolean).join("\n");
        newRegs.push({
          ingredient_id: ing.id, country_code: cc, status: e.status ?? rdc.status,
          max_concentration: e.max_concentration, concentration_unit: "%",
          product_categories: rdc.function_category ? [rdc.function_category] : [],
          conditions: conditionsText,
          source_url: "https://kcia.or.kr/home/law/law_05.php?type=view&no=15087",
          source_document: cc === "BR" ? brSourceDoc : (arSourceDoc ?? brSourceDoc),
          source_version: rdc.filename.match(/\d{4}/)?.[0] ?? "2022",
          source_priority: 100, last_verified_at: now,
          confidence_score: 1.0, override_note: null,
        });
      }
    }
    totalEntries += entries.length;
    totalCreated += created;
    totalProcessed++;
    fingerprints[rdc.filename] = { sha256: sha, parsed_at: now, entry_count: entries.length };
  }

  const existingRegs = await readRows<RegulationRow>("regulations");

  // F15+ (정품검증): 이번 run 에 실제 처리한 RDC 가 0 이면(소스 zip 부재·전부 unchanged) 기존
  // BR/AR 데이터를 절대 건드리지 않음. 과거엔 무조건 prefix-strip 후 newRegs 0 → 전량 소실.
  // KCIA zip 미가용 환경(다른 IP/머신/첫 실행)에서도 데이터가 파괴되지 않도록 보장.
  if (totalProcessed === 0) {
    console.log("  처리된 RDC 0 — 기존 BR/AR regulations·ingredients 보존 (write 생략)");
    return;
  }

  // 현재 RDCS 가 정의하는 유효 source_document 집합 — 이번에 skip(unchanged)된 RDC 의 기존 행은
  // 보존하고, 정의에서 사라진 옛 prefix/suffix(stale) 행만 청소한다.
  const validDocs = new Set<string>();
  for (const rdc of RDCS) {
    validDocs.add(`${SOURCE_PREFIX} — ${rdc.description}`);
    if (rdc.mercosul_basis) {
      const rid = rdc.description.match(/RDC \d+\/\d{4}/)?.[0] ?? rdc.description;
      validDocs.add(`ANMAT Argentina — ${rdc.mercosul_basis} (BR ANVISA ${rid} 동일 채택)`);
    }
  }
  const filteredRegs = existingRegs.filter((r) => {
    if (sourceDocsToReplace.has(r.source_document)) return false;   // 이번에 재처리 = 교체
    // BR-RDC/AR-MERCOSUL 계열인데 현재 유효 doc 가 아닌 것만 stale 로 제거 (유효·unchanged 는 보존).
    const isBrAr = r.source_document.startsWith(`${SOURCE_PREFIX} — RDC `) || r.source_document.startsWith("ANMAT Argentina — MERCOSUL ");
    if (isBrAr && !validDocs.has(r.source_document)) return false;
    return true;
  });
  const finalRegs = [...filteredRegs, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });
  writeFileSync(FINGERPRINT_FILE, JSON.stringify(fingerprints, null, 2));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const byCountry = newRegs.reduce<Record<string, number>>((a, r) => {
    a[r.country_code] = (a[r.country_code] ?? 0) + 1; return a;
  }, {});
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  처리 ${totalProcessed} RDC / skip ${totalSkipped}`);
  console.log(`  entries ${totalEntries} (new ingredients ${totalCreated})`);
  console.log(`  regulations 추가: ${newRegs.length} — ${Object.entries(byCountry).map(([k,v]) => `${k}:${v}`).join(", ")}`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
