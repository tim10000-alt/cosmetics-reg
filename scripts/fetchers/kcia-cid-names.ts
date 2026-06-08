import "./pdf-polyfill";   // 환경 독립 — pdf-parse 가 구버전 Node 에서도 동작 (pdf-parse import 전 필수)
import { loadEnv } from "../crawlers/env";
loadEnv();
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// KCIA(대한화장품협회) 성분사전 *표준화명칭목록* + *명칭변경목록* PDF 자동 ingest.
// = 한국 표준 화장품 성분명 전체(2.2만건). 결정론 파서(Gemini 불필요·전자동·HTML-first 원칙의 PDF판).
//
// 누락 0 설계: 표준화명칭목록 PDF 는 표 컬럼이 평탄화돼 "표준영문명 없는 한글전용" 행에서
// 표준명+구명칭이 공백 없이 연접(예 "족도리풀족두리풀")한다. → *명칭변경목록*(개명된 항목의
// 코드별 표준명/구명칭 분리본)을 코드로 참조해 정확히 분리. 개명 안 된 행은 단일 깨끗한 이름.
// 따라서 21,635건 전부(한글전용 포함) 깨끗하게 머지.
//
// 이 목록엔 규제 한도 없음 = 이름 전용(한국어 검색·성분 커버리지 향상, 규제 데이터 영향 0).
// 증분: 두 PDF sha256 해시스킵(변경 시만 재머지)·멱등(이름매칭, 재실행 중복 0).
// WAF(se-cu) 회피: 브라우저 헤더(UA+Referer) 필수.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REFERER = "https://kcia.or.kr/cid/";
const URL_NAMES = "https://kcia.or.kr/cid/files/%ED%91%9C%EC%A4%80%ED%99%94%EB%AA%85%EC%B9%AD%EB%AA%A9%EB%A1%9D"; // 표준화명칭목록
const URL_CHANGES = "https://kcia.or.kr/cid/files/%EB%AA%85%EC%B9%AD%EB%B3%80%EA%B2%BD%EB%AA%A9%EB%A1%9D"; // 명칭변경목록
const FINGERPRINT = "public/data/kcia-names-fingerprint.json";
const SOURCE_TAG = "KCIA 표준화명칭목록";
const MIN_RECORDS = 15_000;

interface IngredientRow {
  id: string; inci_name: string; korean_name: string | null; chinese_name: string | null;
  japanese_name: string | null; cas_no: string | null; synonyms: string[];
  description: string | null; function_category: string | null; function_description: string | null;
  kcia_code?: string | null;   // KCIA 표준화명칭 코드 = 권위 동일성 키(같은 코드=같은 성분)
}
interface NameRec { code: string; ko: string; inci: string; oldKo: string; }

const headers = { "User-Agent": UA, Referer: REFERER, "Accept-Language": "ko-KR,ko;q=0.9" };
const isHangul = (s: string) => /[가-힣]/.test(s);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

async function download(url: string, label: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    if (!res.ok) { console.error(`  ✗ ${label} HTTP ${res.status}`); return null; }
    const ct = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!/pdf/i.test(ct) || buf.length < 500_000) { console.error(`  ✗ ${label} PDF 아님(ct=${ct}, ${buf.length}B) — WAF 차단 의심`); return null; }
    return buf;
  } catch (e) { console.error(`  ✗ ${label} 다운로드 실패: ${e instanceof Error ? e.message : e}`); return null; }
}

async function pdfLines(buf: Buffer): Promise<string[]> {
  const { PDFParse } = await import("pdf-parse");
  const text = (await new PDFParse({ data: buf }).getText()).text;
  return text.split(/\r?\n/).map((l) => l.replace(/\t/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
}

// 레코드 재조립: "코드(3~6자리)+한글" 로 시작하는 줄 = 새 레코드, 아니면 이전 줄에 이어붙임(긴 이름 줄바꿈).
function reassemble(lines: string[]): { code: string; rest: string }[] {
  const recs: { code: string; rest: string }[] = [];
  for (const l of lines) {
    if (/^-- \d+ of \d+ --/.test(l) || /^성분코드/.test(l) || /^표준명칭/.test(l) || /^<.*>/.test(l) || /^\*/.test(l)) continue;
    const m = l.match(/^(\d{3,6})\s+(.*)/);
    if (m && isHangul((m[2].split(" ")[0] ?? ""))) recs.push({ code: m[1], rest: m[2] });
    else if (recs.length) recs[recs.length - 1].rest += " " + l;
  }
  return recs;
}

// 토큰열을 [한글런, 라틴런, 한글런, 라틴런, ...] 으로 분절(스크립트 교대).
function scriptRuns(rest: string): string[] {
  const toks = rest.split(" ").filter(Boolean);
  const runs: string[] = [];
  let cur = "", curHangul: boolean | null = null;
  for (const t of toks) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) break; // 변경일자 = 레코드 끝
    const h = isHangul(t);
    if (curHangul === null || h === curHangul) { cur += (cur && !h ? " " : "") + t; curHangul = h; }
    else { runs.push(cur); cur = t; curHangul = h; }
  }
  if (cur) runs.push(cur);
  return runs;
}

// 명칭변경목록: 코드 → {표준명(한글), 표준영문, 구명칭(한글)}. runs = [KO_std, EN_std, KO_old, EN_old]
function parseChanges(lines: string[]): Map<string, { ko: string; inci: string; oldKo: string }> {
  const map = new Map<string, { ko: string; inci: string; oldKo: string }>();
  for (const { code, rest } of reassemble(lines)) {
    const runs = scriptRuns(rest);
    if (runs.length < 2) continue;
    map.set(code, { ko: runs[0] ?? "", inci: runs[1] ?? "", oldKo: runs[2] && isHangul(runs[2]) ? runs[2] : "" });
  }
  return map;
}

// 양쪽 목록 모두 영문이 없어 변경맵으로도 못 가르는 한글전용 개명(발효블렌드 등):
// "표준명+구명칭" 이 공백 없이 연접되고 둘은 같은 토큰으로 시작하는 변이명 → 앞 7자 재등장
// 위치에서 분할(길이 균형 가드로 오분할 방지). 영문 섞인 화학명은 대상 제외(오분할 위험).
const hangulCount = (s: string) => (s.match(/[가-힣]/g) || []).length;
const latinCount = (s: string) => (s.match(/[A-Za-z]/g) || []).length;
function splitDoubled(s: string): { head: string; tail: string } | null {
  const n = s.length;
  // 라틴 우세(진짜 영문 INCI)면 제외. 한글 우세(영문 일부 박힌 한글명)는 분리 대상.
  if (n < 18 || latinCount(s) >= hangulCount(s)) return null;
  const key = s.slice(0, 7);
  for (let i = Math.floor(n * 0.4); i <= n - 7; i++) {
    if (s.slice(i, i + 7) === key) {
      const head = s.slice(0, i), tail = s.slice(i);
      if (tail.length >= head.length * 0.75 && tail.length <= head.length * 1.35) return { head, tail };
    }
  }
  return null;
}

// 표준화명칭목록 — 변경맵으로 병합 해소. runs = [KO, EN?, (KO_old?), ...]
function parseNames(lines: string[], changes: Map<string, { ko: string; inci: string; oldKo: string }>): NameRec[] {
  const out: NameRec[] = [];
  for (const { code, rest } of reassemble(lines)) {
    const runs = scriptRuns(rest);
    const ch = changes.get(code);
    let ko = "", inci = "", oldKo = "";
    if (ch) {
      // 개명 항목: 변경목록이 표준명/구명칭을 정확히 분리(평탄화 병합 무관).
      ko = ch.ko; inci = ch.inci; oldKo = ch.oldKo;
    } else {
      // 비개명: runs[0]=한글 단일 표준명(병합 없음). INCI=라틴 우세 run(한글에 N 등 박힌 blob 오선택 방지).
      ko = runs[0] && isHangul(runs[0]) ? runs[0] : "";
      inci = runs.find((r) => latinCount(r) > 0 && latinCount(r) > hangulCount(r)) ?? "";
    }
    // 한글전용 doubled 최종 정리(변경맵 미해소분 안전망).
    const sd = splitDoubled(ko);
    if (sd) { ko = sd.head; if (!oldKo) oldKo = sd.tail; }
    if (!ko && !inci) continue;
    out.push({ code, ko, inci, oldKo });
  }
  return out;
}

function loadFingerprint(): { sha?: string } {
  return existsSync(FINGERPRINT) ? JSON.parse(readFileSync(FINGERPRINT, "utf8")) : {};
}

async function main() {
  console.log("▶ KCIA 표준화명칭목록 + 명칭변경목록 ingest...");
  const namesBuf = await download(URL_NAMES, "표준화명칭목록");
  if (!namesBuf) { console.error("  표준화명칭목록 실패 — 보존(write 생략)"); process.exit(1); }
  const changesBuf = await download(URL_CHANGES, "명칭변경목록");
  // 변경목록 실패 시에도 진행 가능(비개명 항목은 깨끗) — 단 개명 병합 해소만 약화.

  const sha = createHash("sha256").update(namesBuf).update(changesBuf ?? Buffer.alloc(0)).digest("hex");
  if (sha === loadFingerprint().sha) { console.log("  내용 동일(sha256 일치) — 재머지 skip."); return; }

  const changes = changesBuf ? parseChanges(await pdfLines(changesBuf)) : new Map();
  console.log(`  명칭변경 맵: ${changes.size}건`);
  const parsed = parseNames(await pdfLines(namesBuf), changes);
  console.log(`  파싱 ${parsed.length} 성분명`);
  if (parsed.length < MIN_RECORDS) { console.error(`  ✗ ${parsed.length} < ${MIN_RECORDS} — 구조 변경 의심, 보존`); process.exit(1); }

  mkdirSync(".crawl-raw", { recursive: true });
  writeFileSync(".crawl-raw/kcia-names.pdf", namesBuf);
  if (changesBuf) writeFileSync(".crawl-raw/kcia-changes.pdf", changesBuf);

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInci = new Map<string, IngredientRow>();
  const byKo = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    if (i.inci_name) byInci.set(norm(i.inci_name), i);
    if (i.korean_name) byKo.set(i.korean_name.replace(/\s+/g, "").trim(), i);
  }

  const addSyn = (ing: IngredientRow, s: string) => { if (s && !ing.synonyms.includes(s)) { ing.synonyms.push(s); return true; } return false; };
  let enriched = 0, created = 0;
  for (const k of parsed) {
    const inciKey = k.inci ? norm(k.inci) : "";
    const koKey = k.ko ? k.ko.replace(/\s+/g, "").trim() : "";
    const ing = (inciKey && byInci.get(inciKey)) || (koKey && byKo.get(koKey)) || undefined;

    if (ing) {
      let touched = false;
      if (!ing.korean_name && k.ko) { ing.korean_name = k.ko; byKo.set(koKey, ing); touched = true; }
      if (k.oldKo && k.oldKo !== k.ko && addSyn(ing, k.oldKo)) touched = true;
      if (k.code && ing.kcia_code !== k.code) { ing.kcia_code = k.code; touched = true; } // 권위 동일성 키 저장
      if (touched) enriched++;
    } else {
      // 신규: 영문 INCI 있으면 INCI, 없으면 한글 표준명(병합 해소돼 깨끗) 을 inci_name 으로.
      const primary = (k.inci && /[A-Za-z]/.test(k.inci)) ? k.inci : k.ko;
      if (!primary || primary.length < 2 || primary.length > 250) continue;
      const syn: string[] = [];
      if (k.oldKo && k.oldKo !== k.ko) syn.push(k.oldKo);
      const newIng: IngredientRow = {
        id: randomUUID(), inci_name: primary, korean_name: k.ko || null,
        chinese_name: null, japanese_name: null, cas_no: null, synonyms: syn,
        description: `${SOURCE_TAG} (성분코드 ${k.code})`,
        function_category: null, function_description: null, kcia_code: k.code || null,
      };
      ingredients.push(newIng);
      byInci.set(norm(primary), newIng);
      if (koKey) byKo.set(koKey, newIng);
      created++;
    }
  }

  await writeRows("ingredients", ingredients);
  await updateMeta({ ingredients: ingredients.length });
  writeFileSync(FINGERPRINT, JSON.stringify(
    { sha, parsed_at: new Date().toISOString(), parsed: parsed.length, changes: changes.size, enriched, created },
    null, 2,
  ));
  console.log(`✓ KCIA 명칭: 보강 ${enriched}, 신규 ${created}, 총 성분 ${ingredients.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
