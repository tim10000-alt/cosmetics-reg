import { loadEnv } from "./crawlers/env";
loadEnv();
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_SECONDARY } from "./gemini-models";
import { strKey } from "../lib/strhash";

// 표시 텍스트 한국어 번역 파이프라인 (무료 Gemini·결정론 캐시·멱등·장기 자동 누적).
// 일부 국가(대만 TFDA·중국 NMPA·일본 MHLW)의 conditions/source_document 에 번역 안 된 외국어가
// 남아 있다(미완성 번역·이중표기). 이를 *원문 기준* 한국어로 번역해 translations.json 에 캐시.
//   translations.json: { translations: { "<strKey(원문)>": "<한국어>" } }
// 데이터(regulations/*.json)는 불변 — data-loader 가 표시 시점에 strKey 로 조회해 치환(가역·감사).
//
// 🔑 배치 번역: 무료 quota 는 요청(RPM/RPD) 단위라 1요청에 여러 문자열을 번역(JSON)해 요청수를
// ~15배 절감(1건/요청 = quota 즉시 소진 → 6건/일 실측 → 배치로 수천건/일). flash-lite(높은 무료 RPD).
// 비대칭 안전: 실패/quota/외국어잔존 → 캐시 안 함(다음 run 재시도·품질 게이트). 숫자·%·CAS·INCI 보존.
// 우선순위: 외국어-only → 외국어우세 → 한글우세. crawl/enrich/status/identity 와 다른 시간대.

const DATA = join(__dirname, "..", "public", "data");
const REG_DIR = join(DATA, "regulations");
const OUT = join(DATA, "translations.json");

const FOREIGN = /[㐀-鿿぀-ヿ฀-๿Ѐ-ӿ]/;
const FOREIGN_G = /[㐀-鿿぀-ヿ฀-๿Ѐ-ӿ]/g;
const HANGUL_G = /[가-힣]/g;
const needsTranslation = (s: unknown): s is string => typeof s === "string" && s.length > 0 && FOREIGN.test(s);
function priority(s: string): number {
  const f = (s.match(FOREIGN_G) || []).length;
  const h = (s.match(HANGUL_G) || []).length;
  if (h === 0) return 0;
  return h < f ? 1 : 2;
}

const MAX_NEW = Number(process.env.TRANSLATE_MAX ?? 3000);          // 한 run 최대 번역 건수
const BATCH_ITEMS = Number(process.env.TRANSLATE_BATCH_ITEMS ?? 15);
const BATCH_CHARS = Number(process.env.TRANSLATE_BATCH_CHARS ?? 8000);
const ITEM_CHARS = Number(process.env.TRANSLATE_ITEM_CHARS ?? 3500);
const BUDGET_MS = Number(process.env.TRANSLATE_BUDGET_MS ?? 600000);
const CALL_TIMEOUT_MS = Number(process.env.TRANSLATE_CALL_TIMEOUT_MS ?? 60000);
const QUOTA_STOP = Number(process.env.TRANSLATE_QUOTA_STOP ?? 3);
const NULL_STOP = Number(process.env.TRANSLATE_NULL_STOP ?? 8);
const MODEL = process.env.TRANSLATE_MODEL ?? GEMINI_SECONDARY;       // flash-lite = 높은 무료 RPD

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withTimeout<T>(pr: Promise<T>, ms: number): Promise<T> {
  return Promise.race([pr, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("call-timeout")), ms))]);
}

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, ko: { type: "string" } },
        required: ["i", "ko"],
      },
    },
  },
  required: ["items"],
};

function prompt(batch: string[]): string {
  const listed = batch.map((t, i) => `[${i}]\n${t.slice(0, ITEM_CHARS)}`).join("\n\n");
  return `다음은 화장품 규제 공식 문서 텍스트들의 번호 목록입니다. 각 항목을 한국 화장품 연구원이 읽도록 자연스럽고 완전한 한국어로 번역하세요.

규칙:
1) 중국어·일본어 등 모든 외국어를 빠짐없이 번역(각주·비고·단서 포함). 번역 안 된 외국어를 남기지 마세요.
2) 숫자·백분율(%)·단위·CAS 번호·CI 색소번호·화학명/INCI명(로마자)은 그대로 두세요.
3) 줄바꿈·머리표("*","※","순번","(a)") 구조를 보존하세요.
4) 이미 한국어인 부분은 그대로 두세요. 설명을 덧붙이지 말고 번역 본문만.

각 입력 번호 i 에 대해 {i, ko(번역문)} 를 JSON {items:[...]} 로 반환하세요(모든 번호 포함).

${listed}`;
}

type Ask = { items: { i: number; ko: string }[] | null; quota: boolean };
async function ask(p: string): Promise<Ask> {
  let quota = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await withTimeout(ai.models.generateContent({
        model: MODEL, contents: p,
        config: { responseMimeType: "application/json", responseSchema: SCHEMA as unknown as Record<string, unknown>, temperature: 0 },
      }), CALL_TIMEOUT_MS);
      const t = res.text ?? "";
      if (t) { const o = JSON.parse(t); if (Array.isArray(o.items)) return { items: o.items, quota: false }; }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/429|quota|rate|RESOURCE_EXHAUSTED/i.test(msg)) {
        quota = true;
        if (attempt === 0) {
          const m = msg.match(/retry in ([\d.]+)s/i);
          await sleep(Math.min(m ? Math.ceil(parseFloat(m[1])) * 1000 + 1000 : 20000, 45000)); continue;
        }
        return { items: null, quota: true };
      }
      if (/50[0-9]|overload|unavailable|high demand|deadline|ETIMEDOUT|ECONNRESET|fetch failed|call-timeout|timeout/i.test(msg)) {
        await sleep(3000 * (attempt + 1)); continue;
      }
      console.error("  ask err:", msg.slice(0, 120));
      break;
    }
  }
  return { items: null, quota };
}

function clean(out: string): string {
  let s = out.trim();
  s = s.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  if (s.startsWith('"""') && s.endsWith('"""')) s = s.slice(3, -3).trim();
  return s;
}
// 번역 결과 수용 기준 — 외국어가 거의 안 남아야(원문 대비). 미달이면 캐시 안 함(다음 run 재시도).
function accept(src: string, ko: string): boolean {
  if (!ko || !ko.trim()) return false;
  const left = (ko.match(FOREIGN_G) || []).length;
  const srcF = (src.match(FOREIGN_G) || []).length;
  return left <= Math.max(2, srcF * 0.15);
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
  return [...set].sort((a, b) => priority(a) - priority(b) || a.length - b.length);
}

async function main() {
  console.log(`▶ 표시 텍스트 한국어 번역(무료 Gemini 배치·${MODEL})...`);
  const translations: Record<string, string> = existsSync(OUT)
    ? JSON.parse(readFileSync(OUT, "utf8")).translations ?? {} : {};
  const candidates = collectCandidates();
  const todo = candidates.filter((s) => !translations[strKey(s)]);
  console.log(`  대상 고유 ${candidates.length} · 미처리 ${todo.length} · 캐시 ${candidates.length - todo.length}`);

  const save = () => writeFileSync(OUT, JSON.stringify({ generated: "translate-fields", count: Object.keys(translations).length, translations }, null, 0));
  const START = Date.now();
  let done = 0, quotaFail = 0, consecutiveNull = 0, reqs = 0;
  let idx = 0;
  while (idx < todo.length) {
    if (done >= MAX_NEW) { console.log(`  ✔ 배치 상한(${MAX_NEW}건) 도달 — 나머지 다음 run.`); break; }
    if (Date.now() - START > BUDGET_MS) { console.log("  ⏱ 시간 예산 도달 — 부분 처리(나머지 다음 run)."); break; }
    if (consecutiveNull >= NULL_STOP) { console.log(`  ⛔ 연속 ${NULL_STOP}회 일시장애 — 중단(다음 run).`); break; }

    // 문자수·건수 예산으로 배치 구성.
    const batch: string[] = []; let chars = 0;
    while (idx < todo.length && batch.length < BATCH_ITEMS && chars < BATCH_CHARS) {
      const s = todo[idx]; batch.push(s); chars += Math.min(s.length, ITEM_CHARS); idx++;
    }

    const a = await ask(prompt(batch)); reqs++;
    await sleep(1500);
    if (!a.items) {
      if (a.quota) { if (++quotaFail >= QUOTA_STOP) { console.log(`  ⛔ quota ${QUOTA_STOP}연속 소진 — 오늘 run 종료(내일 재개·캐시 멱등).`); break; } }
      else { consecutiveNull++; await sleep(8000); }
      continue;
    }
    quotaFail = 0; consecutiveNull = 0;
    for (const it of a.items) {
      if (typeof it.i !== "number" || it.i < 0 || it.i >= batch.length) continue;
      const src = batch[it.i];
      const ko = clean(String(it.ko ?? ""));
      if (accept(src, ko)) { translations[strKey(src)] = ko; done++; }
    }
    console.log(`  배치 ${reqs}: +${a.items.length} 처리 (누적 신규 ${done})`);
    save();
  }
  save();
  console.log(`✓ 번역: 신규 ${done} · 요청 ${reqs} · 총 캐시 ${Object.keys(translations).length} · 잔여 ${Math.max(0, todo.length - done)}`);
}
main();
