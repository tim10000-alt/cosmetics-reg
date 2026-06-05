import { loadEnv } from "./crawlers/env";
loadEnv();
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_PRIMARY, GEMINI_SECONDARY } from "./gemini-models";

// 보수적 Gemini 식별 판단기 — 결정론(KCIA코드/CAS/neKey/canonName)으로 못 가른 "같은 한글표준명·
// 미병합" 후보쌍만 대상. Gemini 듀얼모델 consensus 가 '같은 물질'로 *둘 다 고신뢰* 동의 + CAS 충돌
// 없을 때만 병합 링크(identity-overrides.json)를 추가. 그 외(다름/불확실)는 분리 유지(안전 기본).
// → data-loader 가 override 링크를 형제로 읽음. 원본 ingredients.json 무변경(되돌림·감사 가능).
// 멱등: 이미 판단한 쌍은 캐시(identity-decisions.json) 스킵 → CI 무료 quota 절약·안정.
// 비대칭 안전: 잘못 병합=규제사고 → 의심스러우면 병합 안 함. CAS 충돌은 LLM 판정보다 우선(veto).

// 트리거: 이 파일/identity.yml 변경 push 시 Identity Judge 워크플로 즉시 1회 실행(백로그 소진).
const DATA = join(__dirname, "..", "public", "data");
const DECISIONS = join(DATA, "identity-decisions.json");
const OVERRIDES = join(DATA, "identity-overrides.json");
const CONF_MIN = 0.8;
const MAX_NEW = Number(process.env.IDJUDGE_MAX ?? 200);   // 한 run 최대 신규 판단(quota 가드)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ing { id: string; inci_name: string; korean_name: string | null; cas_no: string | null; kcia_code?: string | null; }

const validCas = (raw: string | null | undefined): string[] =>
  String(raw || "").match(/\d{2,7}-\d{2}-\d/g) ?? [];
const neKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
const canon = (s: string) => s.toLowerCase().replace(/[；;]/g, ",").replace(/\s*,\s*/g, ",").replace(/\s+/g, " ")
  .replace(/[,\s]*\(\s*cas[^)]*\)/g, "").replace(/[,\s]+c\.?i\.?\s*\d{4,6}/g, "").replace(/[,\s]+$/, "").trim();

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["same", "different", "uncertain"] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["verdict", "confidence", "reason"],
};

function prompt(ko: string, a: Ing, b: Ing): string {
  return `You are a cosmetic-ingredient identity expert. Two database entries share the Korean standardized name "${ko}".
Entry A: INCI="${a.inci_name}", CAS=${a.cas_no || "none"}
Entry B: INCI="${b.inci_name}", CAS=${b.cas_no || "none"}
Are A and B the SAME chemical substance (merely different spelling/case/synonym/registration), or DIFFERENT substances?
Treat as DIFFERENT if: different botanical species (e.g. Lavandula angustifolia vs spica), different plant part ONLY when chemically distinct, different chain length (C6-14 vs C30-45), different salt/ester with different properties, or one is a regulatory GROUP and the other a single substance.
Treat as SAME if: only case/spacing/punctuation/plural differs, US vs INCI spelling, a synonym/old name, or identical chemical with/without a CI/CAS annotation.
Respond JSON: verdict ("same"|"different"|"uncertain"), confidence (0..1), reason (short).`;
}

async function ask(model: string, p: string): Promise<{ verdict: string; confidence: number; reason: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {   // 빠른 실패(quota 죽으면 행 금지)
    try {
      const res = await ai.models.generateContent({
        model, contents: p,
        config: { responseMimeType: "application/json", responseSchema: SCHEMA as unknown as Record<string, unknown>, temperature: 0 },
      });
      const t = res.text ?? "";
      if (t) return JSON.parse(t);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/429|quota|rate/i.test(msg)) { await sleep(6000); continue; }
      console.error("  ask err:", msg.slice(0, 120));
      break;
    }
  }
  return null;
}

async function main() {
  console.log("▶ 식별 판단기(보수적 Gemini consensus)...");
  const ing: Ing[] = JSON.parse(readFileSync(join(DATA, "ingredients.json"), "utf8")).rows;
  const byId = new Map(ing.map((i) => [i.id, i]));
  // 규제 보유 id
  const regBearing = new Set<string>();
  for (const f of readdirSync(join(DATA, "regulations")).filter((x) => x.endsWith(".json"))) {
    const rows = JSON.parse(readFileSync(join(DATA, "regulations", f), "utf8")).rows as { ingredient_id: string }[];
    for (const r of rows) regBearing.add(r.ingredient_id);
  }
  // 같은 한글표준명 그룹
  const byKor = new Map<string, string[]>();
  for (const i of ing) if (i.korean_name) { const k = i.korean_name.trim(); (byKor.get(k) ?? byKor.set(k, []).get(k)!).push(i.id); }

  const alreadyMerged = (a: Ing, b: Ing): boolean => {
    if (a.kcia_code && b.kcia_code && a.kcia_code === b.kcia_code) return true;
    if (canon(a.inci_name) === canon(b.inci_name)) return true;
    const ca = validCas(a.cas_no), cb = validCas(b.cas_no);
    if (ca.some((c) => cb.includes(c))) return true;
    if (a.korean_name && b.korean_name && neKey(a.inci_name) === neKey(b.inci_name) && neKey(a.inci_name).length >= 4) return true;
    return false;
  };
  const casConflict = (a: Ing, b: Ing): boolean => {
    const ca = validCas(a.cas_no), cb = validCas(b.cas_no);
    return ca.length > 0 && cb.length > 0 && !ca.some((c) => cb.includes(c));
  };

  // 후보쌍 수집 — 소규모 그룹(2~4 reg-bearing 멤버)만. 멤버 다수(>4)는 규제 GROUP 엔트리
  // (석유가스·색소목록 = 여러 다른 물질의 묶음)라 병합 대상 아님 → 제외(폭증·오병합 방지).
  const MAX_MEMBERS = 4;
  const pairs: [Ing, Ing][] = [];
  for (const [, ids] of byKor) {
    const members = [...new Set(ids)].map((id) => byId.get(id)!).filter((m) => regBearing.has(m.id));
    if (members.length < 2 || members.length > MAX_MEMBERS) continue;
    for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) {
      const a = members[x], b = members[y];
      if (alreadyMerged(a, b)) continue;
      pairs.push([a, b]);
    }
  }
  console.log(`  후보쌍(소규모 그룹만): ${pairs.length}`);

  const decisions: Record<string, unknown> = existsSync(DECISIONS) ? JSON.parse(readFileSync(DECISIONS, "utf8")).decisions ?? {} : {};
  const key = (a: Ing, b: Ing) => [a.id, b.id].sort().join("|");

  // 하드 시간 예산 + 연속 quota 실패 차단 — 메인 파이프라인(90분 job)을 절대 막지 않음.
  // 미판단분은 다음 run 이 캐시 이어받아 처리(멱등·증분).
  const START = Date.now();
  const BUDGET_MS = Number(process.env.IDJUDGE_BUDGET_MS ?? 300000);   // 5분
  let consecutiveNull = 0;
  let judged = 0, vetoed = 0, cached = 0;
  for (const [a, b] of pairs) {
    const k = key(a, b);
    if (decisions[k]) { cached++; continue; }
    if (casConflict(a, b)) { decisions[k] = { ko: a.korean_name, a: a.inci_name, b: b.inci_name, verdict: "different", by: "cas-veto" }; vetoed++; continue; }
    if (judged >= MAX_NEW) continue;
    if (Date.now() - START > BUDGET_MS) { console.log("  ⏱ 시간 예산 도달 — 부분 판단(나머지 다음 run)"); break; }
    if (consecutiveNull >= 6) { console.log("  ⛔ 연속 quota 실패 — 중단(나머지 다음 run)"); break; }
    const p = prompt(a.korean_name!, a, b);
    const r1 = await ask(GEMINI_PRIMARY, p); await sleep(2000);
    const r2 = await ask(GEMINI_SECONDARY, p); await sleep(2000);
    if (!r1 && !r2) { consecutiveNull++; continue; }   // quota 죽음 — 기록 말고 다음 run 으로(캐시 안 채움)
    consecutiveNull = 0;
    const consensusSame = r1?.verdict === "same" && r2?.verdict === "same" && (r1.confidence ?? 0) >= CONF_MIN && (r2.confidence ?? 0) >= CONF_MIN;
    decisions[k] = {
      ko: a.korean_name, a: a.inci_name, b: b.inci_name,
      m1: r1 ?? null, m2: r2 ?? null,
      verdict: consensusSame ? "same" : (r1?.verdict === "different" || r2?.verdict === "different" ? "different" : "uncertain"),
      by: "gemini-consensus",
    };
    judged++;
    if (judged % 3 === 0) { console.log(`  판단 ${judged}...`); writeFileSync(DECISIONS, JSON.stringify({ generated: "identity-judge", decisions }, null, 2)); }
  }
  writeFileSync(DECISIONS, JSON.stringify({ generated: "identity-judge", decisions }, null, 2));

  // override = consensus 'same' 만(CAS 충돌 veto 는 위에서 different 처리됨)
  const overridePairs = Object.entries(decisions)
    .filter(([, d]) => (d as { verdict: string }).verdict === "same")
    .map(([k, d]) => ({ ids: k.split("|"), ko: (d as { ko: string }).ko, a: (d as { a: string }).a, b: (d as { b: string }).b }));
  writeFileSync(OVERRIDES, JSON.stringify({ generated: "identity-judge", note: "Gemini 듀얼 consensus 로 동일물질 확정된 형제 링크(data-loader 가 병합)", pairs: overridePairs }, null, 2));

  const counts = { same: 0, different: 0, uncertain: 0 } as Record<string, number>;
  for (const d of Object.values(decisions)) counts[(d as { verdict: string }).verdict]++;
  console.log(`✓ 판단: 신규 ${judged} · 캐시 ${cached} · CAS veto ${vetoed}`);
  console.log(`  결과 분포: 같음 ${counts.same} · 다름 ${counts.different} · 불확실 ${counts.uncertain}`);
  console.log(`  override 병합 링크: ${overridePairs.length}`);
}
main();
