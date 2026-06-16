import { loadEnv } from "./crawlers/env";
loadEnv();
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GEMINI_PRIMARY, GEMINI_SECONDARY } from "./gemini-models";

// 전 성분 × 전 국가 헤드라인 셀을 무료 Gemini 가 각국 *현행* 화장품 규제와 대조해 **사람 개입 없이
// 자동 교정**하는 전자동 자가치유 감사기. 법령은 수시로 바뀌므로(영구교정 불가) Gemini 가 계속
// 재판정해 최신 법령에 맞춘다. 검토큐(사람승인)는 전자동이 아니므로 폐기 — 안전장치로 자동 적용.
//
// 안전(자동적용이라 강하게):
//  - 듀얼모델 합의(둘 다 동일 status·동일 한도) + 고신뢰(>=AUTO_CONF, 기본 0.9) 일 때만 자동교정.
//  - **un-ban(허용방향)은 권위 annex veto**: EU AnnexII·NMPA표1·ASEAN Prohibited·KCIA별표1·Andean
//    Decisión·California AB 에 금지 등재면 절대 자동 un-ban 안 함(진짜 금지물질을 허용으로 노출 = 규제
//    사고 방지). banned 방향(더 엄격)은 보수적이라 허용. wrong_limit 는 듀얼 동일숫자만.
//  - 내 원문대조 limit-overrides(prio110)가 있는 셀은 건드리지 않음(최근 직접검증분 보호).
//  - 결과 → gemini-overrides.json. apply-gemini-overrides.cjs 가 regulations 에 prio105 로 baking
//    (MFDS 100 < Gemini 105 < 내 원문 110). 게이트·차분·UI 가 동일하게 봄. 멱등.
//  - 멱등 캐시(셀 hash) + 배치상한 + quota circuit-breaker → 며칠 점진 + 변경셀만 재판정(법령변경 추적).

const DATA = join(__dirname, "..", "public", "data");
const REG_DIR = join(DATA, "regulations");
const CACHE = join(DATA, "audit-cache.json");
const GEMINI_OV = join(DATA, "gemini-overrides.json");
const FINDINGS = join(DATA, "audit-findings.json");
const MARK_MINE = "Claude 원문대조 추출";
const AUTO_CONF = Number(process.env.AUDITCELL_AUTOCONF ?? 0.9);
const MAX_NEW = Number(process.env.AUDITCELL_MAX ?? 400);
const BATCH = Number(process.env.AUDITCELL_BATCH ?? 8);
const BUDGET_MS = Number(process.env.AUDITCELL_BUDGET_MS ?? 1100000);
const QUOTA_STOP = Number(process.env.AUDITCELL_QUOTA_STOP ?? 3);
const COUNTRIES = (process.env.AUDITCELL_COUNTRIES ?? "KR,CN,EU,JP,US,TW,BR,ID,MY,PH,SG,TH,VN,BO,CO,EC,PE,AR,CA").split(",").map((s) => s.trim()).filter(Boolean);
// 권위 금지 annex 패턴(veto — 여기 banned 면 진짜 금지, un-ban 금지). status-judge 와 동형.
const PROHIB_RE = /Annex II|Prohibited|California AB|표1[^\n]*금지|사용 ?금지|사용할 수 없는|Comunidad Andina|Decisi[oó]n|EUR-Lex 1223|安全技术规范.*禁/i;

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
          // 현행 법령상 *올바른* 값. ok 면 현재와 동일.
          correct_status: { type: "string", enum: ["banned", "restricted", "listed", "ok"] },
          correct_max: { type: "string" },   // 숫자(%) 또는 "" (한도없음/불명)
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["i", "correct_status", "correct_max", "confidence", "reason"],
      },
    },
  },
  required: ["results"],
};

function buildPrompt(cells: { i: number; name: string; cas: string; country: string; status: string; max: unknown; cond: string }[]): string {
  const lines = cells.map((c) =>
    `${c.i}. [${c.country}] "${c.name}"${c.cas ? ` (CAS ${c.cas})` : ""} — 현재표기 status=${c.status}, 최대농도=${c.max ?? "없음"}, 조건="${(c.cond || "").slice(0, 140)}"`,
  ).join("\n");
  return `당신은 국가별 화장품 규제 전문가입니다. 각 성분에 대해 "해당 국가의 현행 화장품 규제상 올바른 표기"를 답하세요.
- correct_status: 그 국가에서 실제로 "banned"(금지)/"restricted"(한도·조건부 허용)/"listed"(허용 목록)인지. 현재 표기가 맞으면 "ok".
- correct_max: restricted 면 현행 최대 허용농도 숫자(%, 예 "2.4"), 모르거나 해당없으면 "".
- 확신이 없으면 반드시 correct_status="ok"(현행과 동일 취급, 거짓교정 금지). confidence(0~1)와 한 줄 reason.
- 보수적으로: 근거가 확실할 때만 ok 아닌 값을 주세요. 특히 금지→허용 변경은 매우 확실할 때만.
성분 목록:
${lines}`;
}

async function ask(model: string, prompt: string): Promise<{ r: { i: number; correct_status: string; correct_max: string; confidence: number; reason: string }[] | null; quota: boolean }> {
  try {
    const res = await ai.models.generateContent({ model, contents: prompt, config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 } });
    return { r: (JSON.parse(res.text ?? "").results ?? []), quota: false };
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    if (/PerDay/i.test(msg)) throw new Error("RPD-EXHAUSTED");
    return { r: null, quota: /quota|429|RESOURCE_EXHAUSTED/i.test(msg) };
  }
}
const loadJson = (p: string, def: unknown) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return def; } };
const num = (s: string) => { const m = String(s).match(/\d+\.?\d*/); return m ? parseFloat(m[0]) : null; };

async function main() {
  console.log("▶ 전 셀 Gemini 자동교정 감사(자가치유·법령변경 추적)...");
  const ing: Ing[] = JSON.parse(readFileSync(join(DATA, "ingredients.json"), "utf8")).rows;
  const byId = new Map(ing.map((i) => [i.id, i]));
  const regs: Reg[] = [];
  for (const f of readdirSync(REG_DIR).filter((x) => x.endsWith(".json"))) regs.push(...(JSON.parse(readFileSync(join(REG_DIR, f), "utf8")).rows as Reg[]));

  // 권위 금지 veto 인덱스(id·CAS·국가별) — un-ban 방지.
  const validCas = (s: string | null) => String(s || "").match(/\d{2,7}-\d{2}-\d/g) ?? [];
  const banKey = new Set<string>(); // `${cc}:${id}` or `${cc}:cas:${cas}`
  for (const r of regs) {
    if (r.status !== "banned") continue;
    if (!PROHIB_RE.test(`${r.source_document ?? ""} ${r.conditions ?? ""}`)) continue;
    banKey.add(`${r.country_code}:${r.ingredient_id}`);
    const ig = byId.get(r.ingredient_id);
    if (ig) for (const c of validCas(ig.cas_no)) banKey.add(`${r.country_code}:cas:${c}`);
  }
  const authBanned = (cc: string, ig: Ing) => banKey.has(`${cc}:${ig.id}`) || validCas(ig.cas_no).some((c) => banKey.has(`${cc}:cas:${c}`));

  // 셀(국가,성분) 헤드라인.
  const cellRows = new Map<string, Reg[]>();
  for (const r of regs) { if (!COUNTRIES.includes(r.country_code)) continue; const k = `${r.ingredient_id}:${r.country_code}`; (cellRows.get(k) || cellRows.set(k, []).get(k))!.push(r); }

  const cache: Record<string, { hash: string }> = loadJson(CACHE, { cache: {} }).cache ?? {};
  const corrections: Record<string, unknown> = loadJson(GEMINI_OV, { corrections: {} }).corrections ?? {};
  const findings: Record<string, unknown> = loadJson(FINDINGS, { findings: {} }).findings ?? {};
  const order = new Map(COUNTRIES.map((c, i) => [c, i]));

  const todo: { key: string; name: string; cas: string; country: string; status: string; max: unknown; cond: string; hash: string; igId: string }[] = [];
  for (const [k, rows] of cellRows) {
    const top = rows.reduce((a, b) => (((b.source_priority || 0) > (a.source_priority || 0)) ? b : a));
    if (top.source_document === MARK_MINE) continue; // 내 원문 override 셀 = 보호(스킵)
    const ig = byId.get(top.ingredient_id); if (!ig) continue;
    const cellStr = `${top.status}|${top.max_concentration ?? ""}|${(top.conditions ?? "").slice(0, 140)}`;
    const hash = createHash("sha1").update(cellStr).digest("hex").slice(0, 12);
    if (cache[k]?.hash === hash) continue; // 변경 없음 = 스킵(법령/데이터 안 바뀜)
    todo.push({ key: k, name: ig.korean_name || ig.inci_name, cas: (validCas(ig.cas_no)[0] ?? ""), country: top.country_code, status: top.status, max: top.max_concentration, cond: top.conditions ?? "", hash, igId: ig.id });
  }
  todo.sort((a, b) => (order.get(a.country) ?? 99) - (order.get(b.country) ?? 99));
  console.log(`  대상 셀(미판정/변경): ${todo.length} / 전체 ${cellRows.size}`);

  const START = Date.now();
  let judged = 0, autoFixed = 0, vetoed = 0, queued = 0, quotaFail = 0;
  for (let b = 0; b < todo.length; b += BATCH) {
    if (judged >= MAX_NEW) { console.log(`  ✔ 배치 상한(${MAX_NEW})`); break; }
    if (Date.now() - START > BUDGET_MS) { console.log("  ⏱ 시간예산"); break; }
    if (quotaFail >= QUOTA_STOP) { console.log("  ⛔ quota 소진"); break; }
    const batch = todo.slice(b, b + BATCH).map((c, idx) => ({ ...c, i: idx }));
    let a1, a2;
    try { a1 = await ask(GEMINI_PRIMARY, buildPrompt(batch)); await sleep(1500); a2 = await ask(GEMINI_SECONDARY, buildPrompt(batch)); await sleep(1500); }
    catch (e) { if (String((e as Error).message) === "RPD-EXHAUSTED") { console.log("  ⛔ 일일쿼터 소진 — 종료"); break; } throw e; }
    if (!a1.r || !a2.r) { if (a1.quota || a2.quota) quotaFail++; continue; }
    quotaFail = 0;
    const m1 = new Map(a1.r.map((x) => [x.i, x])); const m2 = new Map(a2.r.map((x) => [x.i, x]));
    for (const c of batch) {
      const v1 = m1.get(c.i), v2 = m2.get(c.i); if (!v1 || !v2) continue;
      cache[c.key] = { hash: c.hash }; judged++;
      // 듀얼 합의 + 고신뢰 + ok 아님 = 교정 후보.
      const agree = v1.correct_status === v2.correct_status && Math.min(v1.confidence, v2.confidence) >= AUTO_CONF;
      if (!agree || v1.correct_status === "ok") { delete corrections[c.key]; continue; }
      const ig = byId.get(c.igId)!;
      const newStatus = v1.correct_status;
      // un-ban 방향(현재 banned → 허용) = 권위 annex veto.
      if (c.status === "banned" && newStatus !== "banned" && authBanned(c.country, ig)) {
        findings[c.key] = { country: c.country, name: c.name, verdict: "un-ban 차단(권위금지)", reason: v1.reason };
        vetoed++; continue;
      }
      // 한도: restricted 면 듀얼 동일숫자만 채택, 아니면 null.
      let mx: number | null = null;
      if (newStatus === "restricted") { const n1 = num(v1.correct_max), n2 = num(v2.correct_max); mx = (n1 != null && n1 === n2) ? n1 : null; }
      corrections[c.key] = { ingredient_id: c.igId, country_code: c.country, status: newStatus, max: mx, from: c.status, confidence: Math.min(v1.confidence, v2.confidence), reason: v1.reason, by: "gemini-consensus", name: c.name };
      autoFixed++;
    }
  }

  writeFileSync(CACHE, JSON.stringify({ cache }, null, 0), "utf8");
  writeFileSync(GEMINI_OV, JSON.stringify({ note: "Gemini 듀얼합의 자동교정(법령변경 자가치유) — apply-gemini-overrides 가 prio105 로 baking. un-ban 은 권위 annex veto. 사람 개입 0.", total: Object.keys(corrections).length, corrections }, null, 2), "utf8");
  writeFileSync(FINDINGS, JSON.stringify({ note: "veto/저신뢰로 자동교정 보류분(가시성용)", total: Object.keys(findings).length, findings }, null, 2), "utf8");
  console.log(`  판정 ${judged}, 자동교정 ${autoFixed}, veto ${vetoed}, 누적교정 ${Object.keys(corrections).length}, 캐시 ${Object.keys(cache).length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
