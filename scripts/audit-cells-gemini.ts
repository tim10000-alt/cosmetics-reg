import { loadEnv } from "./crawlers/env";
loadEnv();
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GEMINI_PRIMARY, GEMINI_SECONDARY } from "./gemini-models";

// 전 성분 × 전 국가 "헤드라인 셀"을 무료 Gemini 가 ground-truth(각국 실제 화장품 규제 지식)와
// 전수 대조하는 자동 감사기. 자기일관성 감사(UI vs 데이터)가 못 잡는 "데이터 진실" 오류
// (false-allowed=금지물질이 허용표기 / false-banned=허용물질이 금지표기 / 한도 오류)를 색출.
//
// 안전·전자동 설계(status-judge 패턴 계승):
//  - 자동수정 절대 안 함 → audit-findings.json(검토큐)에 표면화만. 교정은 사람이 원문확인 후
//    limit-overrides 로(LLM 단독 판정으로 규제 뒤집기 금지 = 규제사고 방지).
//  - 듀얼모델 합의(둘 다 같은 문제 지목 + 고신뢰)만 finding 등록 → 거짓양성 최소화.
//  - 멱등 캐시(audit-cache.json): 셀 내용 hash 가 같으면 재판정 스킵 → 무료 quota 절약, 장기 전자동.
//  - 배치 상한(MAX)·시간예산·quota circuit-breaker(429 연속 시 즉시 종료, 내일 재개) → 무료 Gemini
//    쿼터로 며칠에 걸쳐 전 셀 점진 커버(장기 운용). 변경 셀만 이후 재판정.
//  - 결정론 우선: 이미 override 로 교정됐거나(원문대조) 권위 annex 금지면 스킵(중복 판정 안 함).
//
// 트리거: audit-cells.yml(스케줄/수동). COUNTRIES·AUDITCELL_MAX env 로 점진 확장.

const DATA = join(__dirname, "..", "public", "data");
const REG_DIR = join(DATA, "regulations");
const CACHE = join(DATA, "audit-cache.json");
const FINDINGS = join(DATA, "audit-findings.json");
const CONF_MIN = 0.8;
const MAX_NEW = Number(process.env.AUDITCELL_MAX ?? 300);
const BATCH = Number(process.env.AUDITCELL_BATCH ?? 8);
const BUDGET_MS = Number(process.env.AUDITCELL_BUDGET_MS ?? 600000);
const QUOTA_STOP = Number(process.env.AUDITCELL_QUOTA_STOP ?? 3);
// 전 국가 기본. env 로 우선순위 조정 가능(중요시장 먼저).
const COUNTRIES = (process.env.AUDITCELL_COUNTRIES ?? "KR,CN,EU,JP,US,TW,BR,ID,MY,PH,SG,TH,VN,BO,CO,EC,PE,AR,CA").split(",").map((s) => s.trim()).filter(Boolean);
const MARK = "Claude 원문대조 추출";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ing { id: string; inci_name: string; korean_name: string | null; cas_no: string | null; }
interface Reg { ingredient_id: string; country_code: string; status: string; conditions: string | null; source_document: string | null; max_concentration: number | null; source_priority: number | null; }

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "number" },
          verdict: { type: "string", enum: ["ok", "false_allowed", "false_banned", "wrong_limit"] },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["i", "verdict", "confidence", "reason"],
      },
    },
  },
  required: ["results"],
};

function buildPrompt(cells: { i: number; name: string; cas: string; country: string; status: string; max: unknown; cond: string }[]): string {
  const lines = cells.map((c) =>
    `${c.i}. [${c.country}] "${c.name}"${c.cas ? ` (CAS ${c.cas})` : ""} — 현재표기: status=${c.status}, 최대농도=${c.max ?? "없음"}, 조건="${(c.cond || "").slice(0, 160)}"`,
  ).join("\n");
  return `당신은 국가별 화장품 규제 전문가입니다. 아래 각 성분이 해당 국가의 실제 화장품 규제에 비추어 현재 표기가 옳은지 판정하세요.
각 항목에 verdict:
- "ok": 표기가 실제 규제와 부합(또는 판단 근거 불충분하면 ok 로 보수적 처리)
- "false_allowed": 그 국가에서 실제 금지(prohibited)인데 허용(restricted/listed)으로 표기됨 ★중대
- "false_banned": 그 국가에서 실제 허용(positive-list/제한허용)인데 금지(banned)로 표기됨
- "wrong_limit": status 는 맞으나 최대농도 한도가 실제와 명백히 다름
확신이 없으면 반드시 "ok"(거짓양성 금지). confidence(0~1)와 한 줄 reason 포함.
성분 목록:
${lines}`;
}

async function ask(model: string, prompt: string): Promise<{ r: { i: number; verdict: string; confidence: number; reason: string }[] | null; quota: boolean }> {
  try {
    const res = await ai.models.generateContent({
      model, contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
    });
    const txt = res.text ?? "";
    const parsed = JSON.parse(txt);
    return { r: parsed.results ?? [], quota: false };
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    const quota = /quota|429|RESOURCE_EXHAUSTED|PerDay/i.test(msg);
    if (/PerDay/i.test(msg)) throw new Error("RPD-EXHAUSTED"); // 일일쿼터 소진=즉시중단
    return { r: null, quota };
  }
}

function loadJson(p: string, def: unknown) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return def; } }

async function main() {
  console.log("▶ 전 셀 Gemini ground-truth 감사(false-allowed/banned/wrong-limit)...");
  const ing: Ing[] = JSON.parse(readFileSync(join(DATA, "ingredients.json"), "utf8")).rows;
  const byId = new Map(ing.map((i) => [i.id, i]));
  const regs: Reg[] = [];
  for (const f of readdirSync(REG_DIR).filter((x) => x.endsWith(".json"))) regs.push(...(JSON.parse(readFileSync(join(REG_DIR, f), "utf8")).rows as Reg[]));

  // 셀 = (ingredient,country) 헤드라인. 같은 셀 다중행 → 최고 prio.
  const cellRows = new Map<string, Reg[]>();
  for (const r of regs) { if (!COUNTRIES.includes(r.country_code)) continue; const k = `${r.ingredient_id}:${r.country_code}`; (cellRows.get(k) || cellRows.set(k, []).get(k))!.push(r); }

  const cache: Record<string, { hash: string }> = loadJson(CACHE, { cache: {} }).cache ?? {};
  const findings: Record<string, unknown> = loadJson(FINDINGS, { findings: {} }).findings ?? {};
  const order = new Map(COUNTRIES.map((c, i) => [c, i]));

  // 판정 대상 셀 — override 교정셀은 스킵(이미 원문대조). 캐시 hash 같으면 스킵(멱등).
  const todo: { key: string; i: number; name: string; cas: string; country: string; status: string; max: unknown; cond: string; hash: string }[] = [];
  for (const [k, rows] of cellRows) {
    const top = rows.reduce((a, b) => (((b.source_priority || 0) > (a.source_priority || 0)) ? b : a));
    if (top.source_document === MARK) continue; // 이미 원문대조 교정 = 스킵
    const ig = byId.get(top.ingredient_id); if (!ig) continue;
    const cellStr = `${top.status}|${top.max_concentration ?? ""}|${(top.conditions ?? "").slice(0, 160)}`;
    const hash = createHash("sha1").update(cellStr).digest("hex").slice(0, 12);
    if (cache[k]?.hash === hash) continue; // 변경 없음 → 스킵
    todo.push({ key: k, i: 0, name: ig.korean_name || ig.inci_name, cas: (String(ig.cas_no || "").match(/\d{2,7}-\d{2}-\d/) || [""])[0], country: top.country_code, status: top.status, max: top.max_concentration, cond: top.conditions ?? "", hash });
  }
  todo.sort((a, b) => (order.get(a.country) ?? 99) - (order.get(b.country) ?? 99));
  console.log(`  대상 셀(미판정/변경): ${todo.length} / 전체 ${cellRows.size}`);

  const START = Date.now();
  let judged = 0, flagged = 0, quotaFail = 0;
  for (let b = 0; b < todo.length; b += BATCH) {
    if (judged >= MAX_NEW) { console.log(`  ✔ 배치 상한(${MAX_NEW}) — 나머지 다음 run`); break; }
    if (Date.now() - START > BUDGET_MS) { console.log("  ⏱ 시간예산 도달 — 나머지 다음 run"); break; }
    if (quotaFail >= QUOTA_STOP) { console.log("  ⛔ quota 소진 — 즉시 종료(내일 재개)"); break; }
    const batch = todo.slice(b, b + BATCH).map((c, idx) => ({ ...c, i: idx }));
    const prompt = buildPrompt(batch);
    let a1, a2;
    try { a1 = await ask(GEMINI_PRIMARY, prompt); await sleep(1500); a2 = await ask(GEMINI_SECONDARY, prompt); await sleep(1500); }
    catch (e) { if (String((e as Error).message) === "RPD-EXHAUSTED") { console.log("  ⛔ 일일쿼터 소진 — 종료"); break; } throw e; }
    if (!a1.r || !a2.r) { if ((a1.quota || a2.quota)) quotaFail++; continue; } // 실패 셀 캐시 안 함(다음 run 재시도)
    quotaFail = 0;
    const m1 = new Map(a1.r.map((x) => [x.i, x])); const m2 = new Map(a2.r.map((x) => [x.i, x]));
    for (const c of batch) {
      const v1 = m1.get(c.i), v2 = m2.get(c.i);
      if (!v1 || !v2) continue;
      cache[c.key] = { hash: c.hash }; // 양쪽 응답 = 판정완료 캐시
      judged++;
      // 듀얼 합의 + 고신뢰 + 문제(ok 아님)만 finding. 둘 중 하나라도 ok/불일치면 보수적 스킵.
      if (v1.verdict !== "ok" && v1.verdict === v2.verdict && Math.min(v1.confidence, v2.confidence) >= CONF_MIN) {
        findings[c.key] = { country: c.country, name: c.name, cas: c.cas, status: c.status, max: c.max, verdict: v1.verdict, confidence: Math.min(v1.confidence, v2.confidence), reason: v1.reason };
        flagged++;
      }
    }
  }

  writeFileSync(CACHE, JSON.stringify({ updated: undefined, cache }, null, 0), "utf8");
  writeFileSync(FINDINGS, JSON.stringify({ note: "Gemini 듀얼합의 ground-truth 감사 — 검토 후 limit-overrides 로 교정(자동수정 안 함)", total: Object.keys(findings).length, findings }, null, 2), "utf8");
  console.log(`  판정 ${judged}, 신규 finding ${flagged}, 누적 finding ${Object.keys(findings).length}, 캐시 ${Object.keys(cache).length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
