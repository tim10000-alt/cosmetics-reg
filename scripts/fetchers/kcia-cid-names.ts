import "./pdf-polyfill.ts";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// KCIA(대한화장품협회) 성분사전 *표준화명칭목록* PDF 자동 ingest.
// = 한국 표준 화장품 성분명 전체(2.2만건) — 한글 표준명 + 영문(INCI) + 구명칭.
// 목적: 성분 사전 커버리지·한국어 검색 보강. (이 목록엔 CAS·규제 한도 없음 = 이름 전용.)
//
// 결정론 파서(Gemini 불필요·전자동). 증분: PDF Last-Modified/크기 해시스킵 → 변경 시만 재머지.
// 멱등: 매 run 이름(INCI/한글)로 기존 매칭 → 있으면 보강, 없으면 신규 생성(재실행해도 중복 0).
// dedup 안전: 규제는 손대지 않음(이름만). WAF(se-cu) 회피 위해 브라우저 헤더 필수.

const PDF_URL = "https://kcia.or.kr/cid/files/%ED%91%9C%EC%A4%80%ED%99%94%EB%AA%85%EC%B9%AD%EB%AA%A9%EB%A1%9D"; // 표준화명칭목록
const REFERER = "https://kcia.or.kr/cid/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const RAW = ".crawl-raw/kcia-names.pdf";
const FINGERPRINT = "public/data/kcia-names-fingerprint.json";
const SOURCE_TAG = "KCIA 표준화명칭목록";
const MIN_RECORDS = 15_000; // 이보다 적으면 구조 변경/차단 의심 → 보존

interface IngredientRow {
  id: string; inci_name: string; korean_name: string | null; chinese_name: string | null;
  japanese_name: string | null; cas_no: string | null; synonyms: string[];
  description: string | null; function_category: string | null; function_description: string | null;
}
interface KciaName { code: string; ko: string; inci: string; oldKo: string; }

const headers = { "User-Agent": UA, Referer: REFERER, "Accept-Language": "ko-KR,ko;q=0.9" };

function loadFingerprint(): { sha256?: string; lastModified?: string; length?: string; parsed_at?: string } {
  return existsSync(FINGERPRINT) ? JSON.parse(readFileSync(FINGERPRINT, "utf8")) : {};
}

async function headInfo(): Promise<{ lastModified: string | null; length: string | null } | null> {
  try {
    const res = await fetch(PDF_URL, { method: "HEAD", headers, redirect: "follow" });
    if (!res.ok) return null;
    return { lastModified: res.headers.get("last-modified"), length: res.headers.get("content-length") };
  } catch { return null; }
}

async function download(): Promise<Buffer | null> {
  try {
    const res = await fetch(PDF_URL, { headers, redirect: "follow" });
    if (!res.ok) { console.error(`  ✗ 다운로드 HTTP ${res.status}`); return null; }
    const ct = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!/pdf/i.test(ct) || buf.length < 1_000_000) {
      console.error(`  ✗ PDF 아님(ct=${ct}, ${buf.length}B) — WAF 차단 의심, 보존`);
      return null;
    }
    return buf;
  } catch (e) { console.error(`  ✗ 다운로드 실패: ${e instanceof Error ? e.message : e}`); return null; }
}

const isHangul = (s: string) => /[가-힣]/.test(s);

function parsePdf(text: string): KciaName[] {
  const rawLines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  // 레코드 재조립: "코드(3~6자리)+한글" 로 시작하는 줄 = 새 레코드, 아니면 이전 줄에 이어붙임(긴 이름 줄바꿈 대응).
  const records: string[] = [];
  for (const l of rawLines) {
    if (/^-- \d+ of \d+ --/.test(l) || /^성분코드/.test(l)) continue;
    const m = l.match(/^(\d{3,6})\s+(.*)/);
    if (m && isHangul((m[2].split(" ")[0] ?? ""))) records.push(l);
    else if (records.length) records[records.length - 1] += " " + l;
  }
  const out: KciaName[] = [];
  for (const rec of records) {
    const m = rec.match(/^(\d{3,6})\s+(.*)/);
    if (!m) continue;
    const toks = m[2].split(" ").filter(Boolean);
    const ko: string[] = [], inci: string[] = [], oldKo: string[] = [];
    let phase = 0; // 0=한글표준명 1=영문(INCI) 2=구명칭(한글) 3=이후 무시
    for (const t of toks) {
      const h = isHangul(t);
      if (phase === 0) { if (h) ko.push(t); else { phase = 1; inci.push(t); } }
      else if (phase === 1) { if (!h) inci.push(t); else { phase = 2; oldKo.push(t); } }
      else if (phase === 2) { if (h) oldKo.push(t); else { phase = 3; break; } }
    }
    out.push({ code: m[1], ko: ko.join(""), inci: inci.join(" ").trim(), oldKo: oldKo.join("") });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

async function main() {
  console.log("▶ KCIA 표준화명칭목록 ingest...");
  const fp = loadFingerprint();
  const head = await headInfo();
  if (head && head.lastModified && head.lastModified === fp.lastModified && head.length === fp.length) {
    console.log(`  변경 없음 (Last-Modified ${head.lastModified}) — skip.`);
    return;
  }

  const buf = await download();
  if (!buf) { console.error("  다운로드 실패 — 기존 데이터 보존(write 생략)"); process.exit(1); }
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha === fp.sha256) {
    console.log("  내용 동일(sha256 일치) — 재머지 skip.");
    return;
  }
  mkdirSync(".crawl-raw", { recursive: true });
  writeFileSync(RAW, buf);

  const { PDFParse } = await import("pdf-parse");
  const text = (await new PDFParse({ data: buf }).getText()).text;
  const parsed = parsePdf(text);
  console.log(`  파싱 ${parsed.length} 성분명`);
  if (parsed.length < MIN_RECORDS) { console.error(`  ✗ ${parsed.length} < ${MIN_RECORDS} — 구조 변경 의심, 보존`); process.exit(1); }

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInci = new Map<string, IngredientRow>();
  const byKo = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    if (i.inci_name) byInci.set(norm(i.inci_name), i);
    if (i.korean_name) byKo.set(i.korean_name.replace(/\s+/g, "").trim(), i);
  }

  let enriched = 0, created = 0, skippedKoreanOnly = 0;
  for (const k of parsed) {
    const inciKey = k.inci ? norm(k.inci) : "";
    const koKey = k.ko ? k.ko.replace(/\s+/g, "").trim() : "";
    const ing = (inciKey && byInci.get(inciKey)) || (koKey && byKo.get(koKey)) || undefined;

    if (ing) {
      // 보강(영문 INCI 매칭이라 표준영문명 존재 → 한글명 분리 깨끗): 빈 한글명 채우고 구명칭 보존.
      let touched = false;
      if (!ing.korean_name && k.ko) { ing.korean_name = k.ko; byKo.set(koKey, ing); touched = true; }
      if (k.oldKo && k.oldKo !== k.ko && !ing.synonyms.includes(k.oldKo)) { ing.synonyms.push(k.oldKo); touched = true; }
      if (touched) enriched++;
    } else {
      // 신규: 깨끗한 영문 INCI 가 있는 것만 생성. 한글전용(표준영문명 없음) 행은 표준명·구명칭
      // 분리가 모호(공백 없는 한글 연접)하고 INCI/CAS/규제도 없어 가치 낮음 → skip(개수 로깅).
      if (!k.inci || /[가-힣]/.test(k.inci) || k.inci.length < 2 || k.inci.length > 250) { skippedKoreanOnly++; continue; }
      const newIng: IngredientRow = {
        id: randomUUID(), inci_name: k.inci, korean_name: k.ko || null,
        chinese_name: null, japanese_name: null, cas_no: null,
        synonyms: k.oldKo && k.oldKo !== k.ko && !/[A-Za-z]/.test(k.oldKo) ? [k.oldKo] : [],
        description: `${SOURCE_TAG} (성분코드 ${k.code})`,
        function_category: null, function_description: null,
      };
      ingredients.push(newIng);
      byInci.set(inciKey, newIng);
      if (koKey) byKo.set(koKey, newIng);
      created++;
    }
  }

  await writeRows("ingredients", ingredients);
  await updateMeta({ ingredients: ingredients.length });
  writeFileSync(FINGERPRINT, JSON.stringify(
    { sha256: sha, lastModified: head?.lastModified ?? null, length: head?.length ?? String(buf.length), parsed_at: new Date().toISOString(), parsed: parsed.length, enriched, created },
    null, 2,
  ));
  console.log(`✓ KCIA 명칭: 보강 ${enriched}, 신규 ${created}, 한글전용 skip ${skippedKoreanOnly}, 총 성분 ${ingredients.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
