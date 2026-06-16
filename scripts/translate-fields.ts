import { loadEnv } from "./crawlers/env";
loadEnv();
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_PRIMARY } from "./gemini-models";
import { strKey } from "../lib/strhash";

// 표시 텍스트 한국어 번역 파이프라인 (무료 Gemini·결정론 캐시·멱등·장기 자동 누적).
// 일부 국가(대만 TFDA·중국 NMPA·일본 MHLW)의 conditions/source_document 에 번역 안 된 외국어
// (중국어·일본어 등)가 남아 있다. 이를 *원문 기준* 한국어로 번역해 translations.json 에 캐시한다.
//   translations.json: { translations: { "<strKey(원문)>": "<한국어>" } }
// 데이터(regulations/*.json) 는 불변 — data-loader 가 표시 시점에 strKey 로 조회해 치환(가역·감사).
//
// 비대칭 안전: 번역 실패/quota → 캐시 안 함(다음 run 재시도). 숫자·%·CAS·INCI·CI 코드는 보존.
// 우선순위: 외국어-only → 외국어우세 → 한글우세(이미 한글 있는 보조 참조는 후순위). 배치+캐시로
// 무료 quota 안에서 매일 누적 → 결국 전수 한국어화. crawl/enrich/status/identity 와 다른 시간대.

const DATA = join(__dirname, "..", "public", "data");
const REG_DIR = join(DATA, "regulations");
const OUT = join(DATA, "translations.json");

const FOREIGN = /[㐀-鿿぀-ヿ฀-๿Ѐ-ӿ]/;   // CJK(ext-A+main)·가나·태국어·키릴
const FOREIGN_G = /[㐀-鿿぀-ヿ฀-๿Ѐ-ӿ]/g;
const HANGUL_G = /[가-힣]/g;
const needsTranslation = (s: unknown): s is string => typeof s === "string" && s.length > 0 && FOREIGN.test(s);
// 우선순위 점수(작을수록 먼저): 0=외국어만, 1=외국어우세, 2=한글우세
function priority(s: string): number {
  const f = (s.match(FOREIGN_G) || []).length;
  const h = (s.match(HANGUL_G) || []).length;
  if (h === 0) return 0;
  return h < f ? 1 : 2;
}

const MAX_NEW = Number(process.env.TRANSLATE_MAX ?? 400);
const BUDGET_MS = Number(process.env.TRANSLATE_BUDGET_MS ?? 600000);
const CALL_TIMEOUT_MS = Number(process.env.TRANSLATE_CALL_TIMEOUT_MS ?? 45000);
const QUOTA_STOP = Number(process.env.TRANSLATE_QUOTA_STOP ?? 3);
const NULL_STOP = Number(process.env.TRANSLATE_NULL_STOP ?? 15);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withTimeout<T>(pr: Promise<T>, ms: number): Promise<T> {
  return Promise.race([pr, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("call-timeout")), ms))]);
}

function prompt(text: string): string {
  return `다음은 화장품 규제 공식 문서의 텍스트입니다. 한국 화장품 연구원이 읽도록 자연스럽고 완전한 한국어로 번역하세요.

규칙:
1) 중국어·일본어 등 모든 외국어를 빠짐없이 번역하세요(각주·비고·단서 포함). 번역 안 된 외국어를 절대 남기지 마세요.
2) 숫자·백분율(%)·단위·CAS 번호·CI 색소번호·화학명/INCI명(로마자)은 그대로 두세요.
3) 줄바꿈과 머리표(예: "*", "※", "순번", "(a)")의 구조를 보존하세요.
4) 이미 한국어인 부분은 그대로 두세요.
5) 설명·해설을 덧붙이지 말고, 번역된 본문만 출력하세요.

원문:
"""
${text.slice(0, 4000)}
"""`;
}

type Ask = { text: string | null; quota: boolean };
async function ask(model: string, p: string): Promise<Ask> {
  let quota = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await withTimeout(ai.models.generateContent({
        model, contents: p, config: { temperature: 0 },
      }), CALL_TIMEOUT_MS);
      const t = (res.text ?? "").trim();
      if (t) return { text: t, quota: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/429|quota|rate|RESOURCE_EXHAUSTED/i.test(msg)) {
        quota = true;
        if (attempt === 0) {
          const m = msg.match(/retry in ([\d.]+)s/i);
          await sleep(Math.min(m ? Math.ceil(parseFloat(m[1])) * 1000 + 1000 : 20000, 45000)); continue;
        }
        return { text: null, quota: true };
      }
      if (/50[0-9]|overload|unavailable|high demand|deadline|ETIMEDOUT|ECONNRESET|fetch failed|call-timeout|timeout/i.test(msg)) {
        await sleep(3000 * (attempt + 1)); continue;
      }
      console.error("  ask err:", msg.slice(0, 120));
      break;
    }
  }
  return { text: null, quota };
}

// 번역 결과 위생 — 모델이 가끔 코드펜스/따옴표 래핑을 붙임. 제거.
function clean(out: string): string {
  let s = out.trim();
  s = s.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  if (s.startsWith('"""') && s.endsWith('"""')) s = s.slice(3, -3).trim();
  return s;
}

function collectCandidates(): string[] {
  const set = new Set<string>();
  for (const f of readdirSync(REG_DIR).filter((x) => x.endsWith(".json"))) {
    const rows = JSON.parse(readFileSync(join(REG_DIR, f), "utf8")).rows as Record<string, unknown>[];
    for (const r of rows) {
      for (const field of ["conditions", "source_document", "override_note"]) {
        const v = r[field];
        if (needsTranslation(v)) set.add(v);
      }
      const pc = r["product_categories"];
      if (Array.isArray(pc)) for (const x of pc) if (needsTranslation(x)) set.add(x as string);
    }
  }
  // 외국어-only → 외국어우세 → 한글우세 순(사용자 눈에 띄는 미번역부터 먼저 소진).
  return [...set].sort((a, b) => priority(a) - priority(b) || a.length - b.length);
}

async function main() {
  console.log("▶ 표시 텍스트 한국어 번역(무료 Gemini·캐시·멱등)...");
  const translations: Record<string, string> = existsSync(OUT)
    ? JSON.parse(readFileSync(OUT, "utf8")).translations ?? {} : {};
  const candidates = collectCandidates();
  const todo = candidates.filter((s) => !translations[strKey(s)]);
  console.log(`  번역 대상 고유 문자열 ${candidates.length} · 미처리 ${todo.length} · 캐시 ${candidates.length - todo.length}`);

  const START = Date.now();
  let done = 0, quotaFail = 0, consecutiveNull = 0;
  for (const src of todo) {
    if (done >= MAX_NEW) { console.log(`  ✔ 배치 상한(${MAX_NEW}) 도달 — 나머지 다음 run.`); break; }
    if (Date.now() - START > BUDGET_MS) { console.log("  ⏱ 시간 예산 도달 — 부분 처리(나머지 다음 run)."); break; }
    if (consecutiveNull >= NULL_STOP) { console.log(`  ⛔ 연속 ${NULL_STOP}회 일시장애 — 중단(다음 run).`); break; }

    const a = await ask(GEMINI_PRIMARY, prompt(src));
    await sleep(1500);
    if (!a.text) {
      if (a.quota) { if (++quotaFail >= QUOTA_STOP) { console.log(`  ⛔ quota ${QUOTA_STOP}연속 소진 — 오늘 run 종료(내일 재개·캐시 멱등).`); break; } }
      else { consecutiveNull++; await sleep(8000); }
      continue;
    }
    quotaFail = 0; consecutiveNull = 0;
    const ko = clean(a.text);
    // 결과에 외국어가 그대로 많이 남았으면(번역 실패 의심) 캐시 안 함 — 다음 run 재시도(품질 게이트).
    const foreignLeft = (ko.match(FOREIGN_G) || []).length;
    const foreignSrc = (src.match(FOREIGN_G) || []).length;
    if (ko && (foreignLeft <= Math.max(2, foreignSrc * 0.2))) {
      translations[strKey(src)] = ko;
      done++;
      if (done % 10 === 0) {
        console.log(`  번역 ${done}...`);
        writeFileSync(OUT, JSON.stringify({ generated: "translate-fields", count: Object.keys(translations).length, translations }, null, 0));
      }
    }
  }
  writeFileSync(OUT, JSON.stringify({ generated: "translate-fields", count: Object.keys(translations).length, translations }, null, 0));
  console.log(`✓ 번역: 신규 ${done} · 총 캐시 ${Object.keys(translations).length} · 잔여 ${Math.max(0, todo.length - done)}`);
}
main();
