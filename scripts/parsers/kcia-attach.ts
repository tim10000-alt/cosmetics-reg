import { loadEnv } from "../crawlers/env";
loadEnv();

import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import XLSX from "xlsx";
import { readRows, writeRows, updateMeta } from "../../lib/json-store";
import { GEMINI_PRIMARY } from "../gemini-models";

// KCIA 게시물 첨부의 PDF/xlsx 자동 파싱 — Gemini Flash 호출.
// 무료 tier 안 (일 5 요청 미만 예상). 변경된 첨부만 처리.
//
// known parser 가 정확히 처리하는 첨부 (14208 안전기술규범) 는 skip — 정확도 우선.
// 새/미지의 게시물 첨부만 Gemini 가 ingredient + status 추출.
//
// 구조:
//   kcia-articles.json 의 attachments[].saved_to 파일 SHA256 → fingerprints.json 비교
//   변경 시: PDF→pdf-parse, xlsx→sheet_to_csv → Gemini → JSON 추출 → regulations 머지

const FINGERPRINT_FILE = "public/data/kcia-attach-fingerprints.json";
const SOURCE_PREFIX = "KCIA Gemini auto-parsed";
const MODEL = GEMINI_PRIMARY;

// Cascade fallback 정책 (1안 → 2안 → 3안):
//   1안: 각국 공식 기관 사이트 (Open API/직접 fetch) — 우선
//   2안: KCIA — 1안 차단/실패한 자료만 fallback
//   3안: MFDS — 최후 보조
//
// 아래 SKIP 리스트는 1안 fetcher 가 이미 cover 하는 KCIA 게시물.
// 1안 정확도 우선 — KCIA 의 보조 자료 중복 제외.
const KNOWN_PARSER_HANDLED_NOS = new Set([
  "14208",  // CN 안전기술규범 → cn-nmpa-safety.ts (KCIA xlsx 정확 parser)
  "16818",  // CN IECIC 별표1 (기사용화장품원료목록) → cn-nmpa-iecic.ts (1안 NIFDC API)
  "17544",  // CN IECIC 신원료 등재 공고 → cn-nmpa-iecic.ts 매일 갱신
  "17548",  // CN NMPA 화장품용 생물기술 유래 원료 통칙 → cn:iecic 와 중복 가능
  "17553",  // CN 염모 화장품 기술 지도원칙 → 가이드라인
  "17554",  // CN 염모 화장품 기술 지도원칙 Q&A → 가이드라인
]);

interface KciaAttachment {
  filename: string;
  download_path: string;
  ext: string;
  saved_to: string | null;
  size_bytes: number | null;
  fetched_at: string | null;
}

interface KciaArticle {
  no: string;
  title: string;
  category: string;
  country_inferred: string | null;
  date: string;
  detail_url: string;
  attachments?: KciaAttachment[];
}

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
  [savedTo: string]: { sha256: string; parsed_at: string; entry_count: number; article_no: string };
}

interface GeminiIngredient {
  inci_name: string;
  korean_name?: string | null;
  chinese_name?: string | null;
  cas_no?: string | null;
  status: "banned" | "restricted" | "listed";
  max_concentration?: number | null;
  conditions?: string | null;
}

const SCHEMA = {
  type: "object",
  properties: {
    is_ingredient_regulation: {
      type: "boolean",
      description: "이 문서가 화장품 성분 규제(사용금지/제한/positive list)를 정의하는 표·목록을 포함하면 true. 일반 가이드라인·행정 절차·시험 방법은 false.",
    },
    confidence: { type: "number", description: "추출 신뢰도 0~1" },
    notes: { type: "string", description: "한국어 1~2문장 — 문서 성격·표 구조 요약" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          inci_name: { type: "string" },
          korean_name: { type: "string", nullable: true },
          chinese_name: { type: "string", nullable: true },
          cas_no: { type: "string", nullable: true },
          status: { type: "string", enum: ["banned", "restricted", "listed"] },
          max_concentration: { type: "number", nullable: true },
          conditions: { type: "string", nullable: true },
        },
        required: ["inci_name", "status"],
      },
    },
  },
  required: ["is_ingredient_regulation", "confidence", "ingredients"],
} as const;

// hwpx(한글 워드 — 한국 식약처 고시가 흔히 hwpx 첨부) = zip. Contents/section*.xml 의 <hp:t> 텍스트 추출.
// (구 .hwp 바이너리는 zip 아니라 미지원.) 한국 안전기준 고시 일부개정이 hwpx-only 일 때 Gemini 파싱 가능케.
// yauzl 최소 타입(@types/yauzl 미설치 — 사용하는 멤버만 정의해 any 회피).
interface ZipEntry { fileName: string; }
interface ReadStreamLike { on(ev: "data", cb: (d: Buffer) => void): void; on(ev: "end", cb: () => void): void; }
interface ZipFile {
  on(ev: "entry", cb: (e: ZipEntry) => void): void;
  on(ev: "end", cb: () => void): void;
  openReadStream(e: ZipEntry, cb: (err: Error | null, rs?: ReadStreamLike) => void): void;
  readEntry(): void;
}
interface Yauzl { open(p: string, o: { lazyEntries: boolean }, cb: (err: Error | null, zip?: ZipFile) => void): void; }

async function extractHwpx(filePath: string): Promise<string | null> {
  try {
    const yauzl = (await import("yauzl")).default as unknown as Yauzl;
    return await new Promise<string | null>((resolve) => {
      let text = "";
      yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return resolve(null);
        zip.on("entry", (entry) => {
          if (/^Contents\/section\d+\.xml$/i.test(entry.fileName)) {
            zip.openReadStream(entry, (e, rs) => {
              if (e || !rs) return zip.readEntry();
              const chunks: Buffer[] = [];
              rs.on("data", (d) => chunks.push(d));
              rs.on("end", () => {
                const xml = Buffer.concat(chunks).toString("utf8");
                text += [...xml.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join(" ") + " ";
                zip.readEntry();
              });
            });
          } else zip.readEntry();
        });
        zip.on("end", () => resolve(text.replace(/\s+/g, " ").trim() || null));
        zip.readEntry();
      });
    });
  } catch (e) {
    console.warn(`  hwpx 추출 실패: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function extractText(savedTo: string, ext: string): Promise<string | null> {
  if (/\.hwpx$/i.test(ext) || /\.hwpx$/i.test(savedTo)) return extractHwpx(savedTo);
  if (/\.pdf$/i.test(ext) || /\.pdf$/i.test(savedTo)) {
    try {
      const { PDFParse } = await import("pdf-parse");
      const buf = readFileSync(savedTo);
      const p = new PDFParse({ data: buf });
      const r = await p.getText();
      return r.text;
    } catch (e) {
      console.warn(`  pdf-parse 실패: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
  if (/\.xlsx$/i.test(ext) || /\.xlsx$/i.test(savedTo)) {
    try {
      const wb = XLSX.readFile(savedTo);
      const parts: string[] = [];
      for (const sn of wb.SheetNames) {
        const ws = wb.Sheets[sn];
        const csv = XLSX.utils.sheet_to_csv(ws, { strip: true });
        parts.push(`=== sheet: ${sn} ===\n${csv}`);
      }
      return parts.join("\n\n");
    } catch (e) {
      console.warn(`  xlsx 읽기 실패: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
  return null;
}

function buildPrompt(article: KciaArticle, text: string): string {
  return `한국 화장품 협회(KCIA) 게시물의 첨부 파일 내용입니다. 화장품 성분 규제(사용 금지·제한·positive list 등) 데이터가 표·목록 형태로 들어있다면 ingredient 별로 추출해 JSON 으로 반환해 주세요.

게시물 제목: ${article.title}
국가: ${article.country_inferred ?? "(미상)"}
카테고리: ${article.category}

엄격한 규칙:
- inci_name 은 표준 INCI(영문) 명칭 우선. 없으면 영문 학명/일반명. 한글만 있으면 한글 그대로.
- status: 사용 금지=banned, 사용 제한(농도 한도)=restricted, positive list(허용 보존제/UV/색소 등)=listed.
- 농도가 있으면 max_concentration (숫자, 단위는 conditions 에 기록).
- 표·목록이 아닌 일반 가이드라인·행정 절차·시험 방법 문서면 is_ingredient_regulation=false 반환 후 ingredients 빈 배열.
- 추측 금지. 표가 없거나 구조가 모호하면 ingredients 빈 배열.
- 한 게시물의 첨부 1개에 너무 많은 ingredient 가 있으면 200개까지만.

문서 내용:
${text.slice(0, 100000)}`;
}

async function parseAttachmentWithGemini(
  ai: GoogleGenAI,
  article: KciaArticle,
  attach: KciaAttachment,
): Promise<{ entries: GeminiIngredient[]; isIngredientReg: boolean; notes: string; confidence: number } | null> {
  if (!attach.saved_to || !existsSync(attach.saved_to)) return null;
  const text = await extractText(attach.saved_to, attach.ext);
  if (!text || text.length < 100) {
    console.log(`  ⊘ ${attach.filename}: 텍스트 추출 실패 또는 너무 짧음`);
    return null;
  }
  console.log(`  ▶ ${attach.filename} (${(text.length / 1024).toFixed(0)}KB text) → Gemini`);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: MODEL,
        contents: buildPrompt(article, text),
        config: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA as unknown as Record<string, unknown>,
          temperature: 0,
        },
      });
      const parsed = JSON.parse(res.text ?? "{}");
      return {
        entries: parsed.ingredients ?? [],
        isIngredientReg: parsed.is_ingredient_regulation ?? false,
        notes: parsed.notes ?? "",
        confidence: parsed.confidence ?? 0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/429|RESOURCE_EXHAUSTED|UNAVAILABLE|503/i.test(msg) && attempt < 4) {
        const wait = 5_000 * 2 ** (attempt - 1);
        console.warn(`  retry ${attempt} after ${wait / 1000}s: ${msg.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.error(`  ✗ Gemini 실패: ${msg.slice(0, 200)}`);
      return null;
    }
  }
  return null;
}

async function main() {
  const fingerprints: Fingerprint = existsSync(FINGERPRINT_FILE)
    ? JSON.parse(readFileSync(FINGERPRINT_FILE, "utf8"))
    : {};

  const articles = await readRows<KciaArticle>("kcia-articles");
  const ingredients = await readRows<IngredientRow>("ingredients");
  const regulations = await readRows<RegulationRow>("regulations");

  const byInci = new Map<string, IngredientRow>();
  const byCas = new Map<string, IngredientRow>();
  const byKorean = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    byInci.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) { byCas.set(i.cas_no, i); for (const c of i.cas_no.split(/[\s,;/]+/)) { const t = c.trim().replace(/\(.*$/, ""); if (t && t !== i.cas_no) byCas.set(t, i); } }  // 다중 CAS 토큰별 키 추가(쉼표/세미콜론/슬래시·주석strip·분절 방지·전체문자열 키 유지=무회귀)
    if (i.korean_name) byKorean.set(i.korean_name, i);
  }

  // 변경된 첨부 수집 — SHA256 비교
  const changed: Array<{ article: KciaArticle; attach: KciaAttachment; sha256: string }> = [];
  for (const a of articles) {
    if (KNOWN_PARSER_HANDLED_NOS.has(a.no)) continue;
    if (!a.attachments) continue;
    for (const att of a.attachments) {
      if (!att.saved_to || !existsSync(att.saved_to)) continue;
      // PDF/xlsx/hwpx (hwpx=한글 신규 zip 포맷 텍스트 추출 가능. 구 .hwp 바이너리·docx 만 제외).
      if (!/\.(pdf|xlsx|hwpx)$/i.test(att.saved_to)) continue;
      const buf = readFileSync(att.saved_to);
      const sha = createHash("sha256").update(buf).digest("hex");
      const fp = fingerprints[att.saved_to];
      if (fp && fp.sha256 === sha) continue;
      changed.push({ article: a, attach: att, sha256: sha });
    }
  }

  console.log(`▶ KCIA 첨부 자동 파싱 — 변경/신규 ${changed.length}건 (총 ${articles.reduce((n, a) => n + (a.attachments?.length ?? 0), 0)}건 중)`);
  if (changed.length === 0) {
    console.log("  변경 없음. skip.");
    return;
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY 미설정. .env.local 또는 GitHub Secrets 확인.");
    process.exit(1);
  }

  const now = new Date().toISOString();
  const newRegs: RegulationRow[] = [];
  let totalMatched = 0, totalCreated = 0, processedAttachments = 0;
  const sourceDocsToReplace = new Set<string>();

  for (const { article, attach, sha256 } of changed) {
    console.log(`\n[${article.no}] ${article.title}`);
    const result = await parseAttachmentWithGemini(ai, article, attach);
    if (!result) {
      // 기록은 남겨 다음 cron 에 다시 시도하지 않게
      fingerprints[attach.saved_to!] = { sha256, parsed_at: now, entry_count: 0, article_no: article.no };
      continue;
    }
    if (!result.isIngredientReg) {
      console.log(`  ⊘ Gemini: 성분 규제 문서 아님 — ${result.notes}`);
      fingerprints[attach.saved_to!] = { sha256, parsed_at: now, entry_count: 0, article_no: article.no };
      continue;
    }
    if (result.confidence < 0.5) {
      console.log(`  ⊘ Gemini 신뢰도 낮음 ${result.confidence.toFixed(2)} — ${result.notes}`);
      fingerprints[attach.saved_to!] = { sha256, parsed_at: now, entry_count: 0, article_no: article.no };
      continue;
    }

    const sourceDoc = `${SOURCE_PREFIX}: KCIA-${article.no} ${attach.filename}`;
    sourceDocsToReplace.add(sourceDoc);
    let matched = 0, created = 0;
    for (const e of result.entries) {
      const cleanInci = (e.inci_name ?? "").trim();
      if (!cleanInci || cleanInci.length < 2 || cleanInci.length > 300) continue;
      let ing = byInci.get(cleanInci.toLowerCase());
      if (!ing && e.cas_no) ing = byCas.get(e.cas_no);
      if (!ing && e.korean_name) ing = byKorean.get(e.korean_name);
      if (!ing) {
        ing = {
          id: randomUUID(), inci_name: cleanInci,
          korean_name: e.korean_name ?? null, chinese_name: e.chinese_name ?? null, japanese_name: null,
          cas_no: e.cas_no ?? null, synonyms: [], description: null,
          function_category: null, function_description: null,
        };
        ingredients.push(ing);
        byInci.set(cleanInci.toLowerCase(), ing);
        if (e.cas_no) byCas.set(e.cas_no, ing);
        created++;
      } else {
        matched++;
        if (!ing.cas_no && e.cas_no) ing.cas_no = e.cas_no;
        if (!ing.chinese_name && e.chinese_name) ing.chinese_name = e.chinese_name;
        if (!ing.korean_name && e.korean_name) ing.korean_name = e.korean_name;
      }
      const country = article.country_inferred ?? (article.category === "중국법령" ? "CN" : "?");
      newRegs.push({
        ingredient_id: ing.id, country_code: country, status: e.status,
        max_concentration: e.max_concentration ?? null, concentration_unit: "%",
        product_categories: [],
        conditions: [
          `KCIA-${article.no} "${article.title}" Gemini 자동 파싱.`,
          `첨부: ${attach.filename}`,
          e.conditions ? `조건: ${e.conditions}` : null,
          `Gemini notes: ${result.notes}`,
          `신뢰도: ${result.confidence.toFixed(2)}`,
        ].filter(Boolean).join("\n"),
        source_url: article.detail_url, source_document: sourceDoc,
        source_version: `${article.date}-gemini-auto`, source_priority: 80, // known parser(100) 보다 낮음
        last_verified_at: now,
        confidence_score: result.confidence, override_note: null,
      });
    }
    totalMatched += matched; totalCreated += created;
    processedAttachments++;
    fingerprints[attach.saved_to!] = { sha256, parsed_at: now, entry_count: result.entries.length, article_no: article.no };
    console.log(`  ✓ ${result.entries.length} ingredients (matched ${matched} + new ${created}, conf ${result.confidence.toFixed(2)})`);

    // Gemini 무료 tier 10 RPM 안전 마진 — 첨부 사이 7초 대기
    await new Promise((r) => setTimeout(r, 7_000));
  }

  // 머지 — 같은 source_document 의 기존 행 제거 후 새 row 삽입
  const filteredRegs = regulations.filter((r) => !sourceDocsToReplace.has(r.source_document));
  const finalRegs = [...filteredRegs, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });
  writeFileSync(FINGERPRINT_FILE, JSON.stringify(fingerprints, null, 2));

  console.log(`\n=== summary ===`);
  console.log(`  처리 첨부: ${processedAttachments} / 변경 후보 ${changed.length}`);
  console.log(`  신규 regulations: ${newRegs.length} (matched ${totalMatched} + new ingredients ${totalCreated})`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
