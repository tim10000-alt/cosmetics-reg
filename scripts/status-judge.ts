import { loadEnv } from "./crawlers/env";
loadEnv();
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_PRIMARY, GEMINI_SECONDARY } from "./gemini-models";

// 보수적 Gemini status 판단기 — "사용제한 자료" 출처에서 status=banned 인데 conditions 에 배합한도
// 텍스트가 있는 행(=오분류 후보)을 대상. 두 부류가 섞여 있어 양방향 자동결정이 모두 위험:
//   (a) 과산화수소형: 실제 restricted(제품별 허용농도 보유)인데 banned 로 오매핑 → restricted 로 교정 필요.
//   (b) 파라벤형: 실제 banned 인데 금지 전 과거한도("0.4%") 텍스트만 잔존 → 교정하면 금지물질을 "허용"
//       으로 표기 = 규제사고. 절대 교정 금지.
// 분별: ① 결정론 veto — 권위 금지 annex(EU AnnexII·ASEAN Prohibited·Andean Decisión·California
//          AB2762·NMPA 표1금지)에 등재된 물질은 진짜 금지 → 교정 안 함, 검토큐(파라벤형 hard guard,
//          identity-judge 의 CAS-veto 와 동형). LLM 판정보다 우선.
//       ② Gemini 듀얼모델이 conditions *원문* 을 읽고 banned vs restricted 판정. 둘 다 고신뢰
//          'restricted' 동의 + veto 없을 때만 교정(status-overrides.json). 그 외(banned/uncertain/
//          veto)는 분리 유지·검토큐(status-decisions.json).
// → data-loader 가 override 를 읽어 row.status 를 교정(원본 regulations/*.json 무변경=가역·감사).
// 멱등: 판단한 행은 캐시 스킵 → CI 무료 quota 절약. 비대칭 안전: 의심=교정 안 함.
// 트리거: 이 파일/status.yml 변경 push 시 1회(백로그 소진). KR 144 먼저(STATUS_COUNTRIES).

const DATA = join(__dirname, "..", "public", "data");
const REG_DIR = join(DATA, "regulations");
const DECISIONS = join(DATA, "status-decisions.json");
const OVERRIDES = join(DATA, "status-overrides.json");
const CONF_MIN = 0.8;
const MAX_NEW = Number(process.env.STATUSJUDGE_MAX ?? 200);
// 첫 배포는 KR 만(사용자 지시 "KR 144 먼저"). 이후 run/env 로 확장(CN·TW…).
const COUNTRIES = (process.env.STATUS_COUNTRIES ?? "KR").split(",").map((s) => s.trim()).filter(Boolean);
// banned + 한도텍스트 = 오분류 후보(메모리 정의 regex).
const LIMIT_RE = /배합한도|최대사용농도|허용된 최대농도/;
// 교정 대상 출처 = MFDS 사용제한 자료만(다른 권위 출처 banned 는 건드리지 않음).
const SOURCE_MATCH = "MFDS";
// 권위 금지 annex 출처/조건 패턴 — 여기 banned 면 진짜 금지(veto).
const PROHIB_RE = /Annex II|Prohibited|California AB|표1[^\n]*금지|사용 금지 물질|Comunidad Andina|EUR-Lex 1223/i;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ing { id: string; inci_name: string; korean_name: string | null; cas_no: string | null; }
interface Reg {
  ingredient_id: string; country_code: string; status: string;
  conditions: string | null; source_document: string | null; max_concentration: number | null;
}

const validCas = (raw: string | null | undefined): string[] =>
  String(raw || "").match(/\d{2,7}-\d{2}-\d/g) ?? [];
const canonName = (s: string) => s.toLowerCase().replace(/[；;]/g, ",").replace(/\s*,\s*/g, ",")
  .replace(/\s+/g, " ").replace(/[,\s]*\(\s*cas[^)]*\)/g, "").replace(/[,\s]+c\.?i\.?\s*\d{4,6}/g, "").replace(/[,\s]+$/, "").trim();

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["restricted", "banned", "uncertain"] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["verdict", "confidence", "reason"],
};

function prompt(ing: Ing, countryKo: string, conditions: string): string {
  return `You are a cosmetic-regulation expert. A database row says ingredient "${ing.inci_name}"${ing.korean_name ? ` (Korean: ${ing.korean_name})` : ""} is currently "banned" in ${countryKo}, but its regulatory conditions text contains concentration-limit wording. Decide, based ONLY on the regulatory text below (not your training memory of dates), whether this ingredient is in reality:
- "restricted": currently ALLOWED in ${countryKo} under the stated concentration limit(s) / for specific product types (the "banned" label is a misclassification of a use-restricted ingredient). Typical signal: the text grants an allowed concentration for at least one product/use (e.g. "두발용 제품류에 3%", "염모제에서 12%").
- "banned": genuinely PROHIBITED now; the concentration figure is a stale/historical limit from before it was banned (e.g. a paraben that was later moved to the prohibited list but kept its old 0.4% text). Typical signal: a general acid-equivalent limit with no current product allowance, for a substance known to be globally prohibited.
- "uncertain": the text is ambiguous or you cannot tell.

Regulatory conditions text:
"""
${conditions.slice(0, 1200)}
"""
Be conservative: if there is any doubt that it is genuinely allowed, answer "banned" or "uncertain" — never call a prohibited substance "restricted". Respond JSON: verdict, confidence (0..1), reason (short).`;
}

const CALL_TIMEOUT_MS = Number(process.env.STATUSJUDGE_CALL_TIMEOUT_MS ?? 30000);
// @google/genai 는 요청 타임아웃이 없어 연결이 hang 하면(응답·에러 둘 다 없음 = "API 무응답")
// await 가 영구 대기 → run 전체 정지. Promise.race 로 per-call 타임아웃 = hang 을 잡아 재시도/스킵.
function withTimeout<T>(pr: Promise<T>, ms: number): Promise<T> {
  return Promise.race([pr, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("call-timeout")), ms))]);
}

type AskResult = { r: { verdict: string; confidence: number; reason: string } | null; quota: boolean };
// 429(quota)와 503/timeout(일시적)을 *구분*해 반환 — 호출자가 quota 소진 시 빠르게 종료(무의미한 spin
// 방지)하고 일시적 장애는 인내하도록. 429 는 RPM 회복 기회로 1회만(캡 45s) 대기 후 재시도, 그래도
// 429 면 quota=true 신호. (전엔 429 를 4회 × 65s 매달려 CI 분 낭비 = 사용자가 지적한 "무의미하게 돎".)
async function ask(model: string, p: string): Promise<AskResult> {
  let quota = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await withTimeout(ai.models.generateContent({
        model, contents: p,
        config: { responseMimeType: "application/json", responseSchema: SCHEMA as unknown as Record<string, unknown>, temperature: 0 },
      }), CALL_TIMEOUT_MS);
      const t = res.text ?? "";
      if (t) return { r: JSON.parse(t), quota: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/429|quota|rate|RESOURCE_EXHAUSTED/i.test(msg)) {
        quota = true;
        // RPM(분당20) 일시 초과면 "retry in Ns"(캡45s) 1회 대기로 회복. 그래도 429 = RPD(일일) 소진
        // 가능성 → 더 안 매달리고 quota 신호 반환(호출자가 circuit-break).
        if (attempt === 0) {
          const m = msg.match(/retry in ([\d.]+)s/i);
          await sleep(Math.min(m ? Math.ceil(parseFloat(m[1])) * 1000 + 1000 : 20000, 45000)); continue;
        }
        return { r: null, quota: true };
      }
      if (/50[0-9]|overload|unavailable|high demand|deadline|ETIMEDOUT|ECONNRESET|fetch failed|call-timeout|timeout/i.test(msg)) {
        await sleep(3000 * (attempt + 1)); continue;                              // 일시적 5xx/네트워크/hang — 지수 백오프 재시도
      }
      console.error("  ask err:", msg.slice(0, 120));
      break;
    }
  }
  return { r: null, quota };
}

function loadRegs(): Reg[] {
  const out: Reg[] = [];
  for (const f of readdirSync(REG_DIR).filter((x) => x.endsWith(".json"))) {
    out.push(...(JSON.parse(readFileSync(join(REG_DIR, f), "utf8")).rows as Reg[]));
  }
  return out;
}

async function main() {
  console.log("▶ status 판단기(보수적 Gemini consensus, banned↔restricted)...");
  const ing: Ing[] = JSON.parse(readFileSync(join(DATA, "ingredients.json"), "utf8")).rows;
  const byId = new Map(ing.map((i) => [i.id, i]));
  const countryKo = new Map(
    (JSON.parse(readFileSync(join(DATA, "countries.json"), "utf8")).rows as { code: string; name_ko: string }[])
      .map((c) => [c.code, c.name_ko]),
  );
  const regs = loadRegs();

  // 권위 금지 annex 등재 인덱스(veto) — id·CAS·canonName 키로(형제 split 방어).
  const banId = new Set<string>(), banCas = new Set<string>(), banName = new Set<string>();
  for (const r of regs) {
    if (r.status !== "banned") continue;
    if (!PROHIB_RE.test(`${r.source_document ?? ""} ${r.conditions ?? ""}`)) continue;
    banId.add(r.ingredient_id);
    const ig = byId.get(r.ingredient_id);
    if (ig) {
      for (const c of validCas(ig.cas_no)) banCas.add(c);
      if (ig.inci_name) banName.add(canonName(ig.inci_name));
    }
  }
  const isProhibitedElsewhere = (ig: Ing): boolean => {
    if (banId.has(ig.id)) return true;
    if (validCas(ig.cas_no).some((c) => banCas.has(c))) return true;
    if (ig.inci_name && banName.has(canonName(ig.inci_name))) return true;
    return false;
  };

  // 후보 = 대상국 + status banned + MFDS 사용제한 출처 + 한도텍스트.
  // COUNTRIES env 순서대로 정렬 → "KR 먼저"(최중요 시장) 우선 소진, 그 다음 CN·TW.
  const order = new Map(COUNTRIES.map((c, i) => [c, i]));
  const candidates = regs.filter(
    (r) => COUNTRIES.includes(r.country_code) && r.status === "banned" &&
      (r.source_document ?? "").includes(SOURCE_MATCH) && r.conditions && LIMIT_RE.test(r.conditions),
  ).sort((a, b) => (order.get(a.country_code)! - order.get(b.country_code)!));
  const perCountry = COUNTRIES.map((c) => `${c}:${candidates.filter((r) => r.country_code === c).length}`).join(" ");
  console.log(`  후보(${perCountry}) 총 ${candidates.length}`);

  const decisions: Record<string, unknown> = existsSync(DECISIONS)
    ? JSON.parse(readFileSync(DECISIONS, "utf8")).decisions ?? {} : {};
  const key = (r: Reg) => `${r.ingredient_id}:${r.country_code}`;

  const START = Date.now();
  const BUDGET_MS = Number(process.env.STATUSJUDGE_BUDGET_MS ?? 300000);
  // 503(high demand) 폭주에 견디기 — 연속 양쪽-null 이 이만큼 쌓여야 중단(전엔 6=너무 일찍 포기).
  // 폭주는 일시적이라 쿨다운 후 재시도하면 대개 회복. 시간 예산이 최종 안전망(CI job 안 막음).
  const NULL_STOP = Number(process.env.STATUSJUDGE_NULL_STOP ?? 15);
  // quota(429) circuit-breaker — 연속 이만큼 candidate 가 *quota* 로 실패하면 "오늘 quota 소진"으로
  // 보고 즉시 종료(다음 run/내일 재개). 503(일시) 인내와 분리 = quota 소진 시 무의미한 spin·CI 분
  // 낭비 방지(사용자 지적). 정상상태(신규 소수)는 애초에 quota 안 막힘.
  const QUOTA_STOP = Number(process.env.STATUSJUDGE_QUOTA_STOP ?? 3);
  let consecutiveNull = 0, quotaFail = 0, judged = 0, vetoed = 0, cached = 0;
  for (const r of candidates) {
    const k = key(r);
    if (decisions[k]) { cached++; continue; }
    const ig = byId.get(r.ingredient_id);
    if (!ig) continue;
    // 결정론 veto — 권위 금지 annex 등재 = 진짜 금지(파라벤형). 교정 안 함, 검토큐.
    if (isProhibitedElsewhere(ig)) {
      decisions[k] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code,
        verdict: "banned", by: "prohibition-veto" };
      vetoed++; continue;
    }
    if (judged >= MAX_NEW) { console.log(`  ✔ 배치 상한(${MAX_NEW}) 도달 — 나머지 다음 run(지속가능 배치).`); break; }
    if (Date.now() - START > BUDGET_MS) { console.log("  ⏱ 시간 예산 도달 — 부분 판단(나머지 다음 run)"); break; }
    if (consecutiveNull >= NULL_STOP) { console.log(`  ⛔ 연속 ${NULL_STOP}회 일시장애 — 중단(나머지 다음 run)`); break; }
    const p = prompt(ig, countryKo.get(r.country_code) ?? r.country_code, r.conditions!);
    const a1 = await ask(GEMINI_PRIMARY, p); await sleep(2000);
    const a2 = await ask(GEMINI_SECONDARY, p); await sleep(2000);
    const r1 = a1.r, r2 = a2.r;
    // 한쪽이라도 실패면 진짜 consensus 판정 불가 → 캐시 안 하고 다음 run 재시도.
    // (거짓 uncertain/banned 영구캐시 방지 — 예: 과산화수소 m1=null/m2=restricted 가 uncertain 으로 굳는 문제.)
    if (!r1 || !r2) {
      const bothQuota = (!r1 && a1.quota) && (!r2 && a2.quota);
      if (bothQuota) {
        // 무료 quota 소진 — 이 run 에선 회복 안 됨. 빠르게 circuit-break(무의미한 spin 금지).
        if (++quotaFail >= QUOTA_STOP) { console.log(`  ⛔ quota 소진 ${QUOTA_STOP}연속 — 오늘 run 종료(다음 run/내일 재개·캐시 멱등). CI 분 낭비 방지.`); break; }
      } else if (!r1 && !r2) {
        consecutiveNull++; await sleep(15000);   // 503/네트워크 일시 폭주 — 쿨다운 후 다음 후보
      }
      continue;
    }
    consecutiveNull = 0; quotaFail = 0;
    const hi = (x: { confidence?: number } | null) => (x?.confidence ?? 0) >= CONF_MIN;
    const consensusRestricted =
      r1?.verdict === "restricted" && r2?.verdict === "restricted" && hi(r1) && hi(r2);
    // 분리(한 모델 restricted / 다른 banned, 둘 다 고신뢰)는 보수적으로 banned 가 기본(안전측).
    // 단 자동 해결을 위해 *3차 tiebreaker*(primary 재질의) 1회 — restricted 고신뢰면 다수결(2/3)로
    // restricted 채택, 아니면 banned 유지. veto 는 위에서 이미 처리(진짜 금지는 여기 안 옴).
    let r3: { verdict: string; confidence: number; reason: string } | null = null;
    const isSplit = !consensusRestricted &&
      ((r1?.verdict === "restricted" && hi(r1) && r2?.verdict === "banned") ||
       (r2?.verdict === "restricted" && hi(r2) && r1?.verdict === "banned"));
    if (isSplit) {
      r3 = (await ask(GEMINI_PRIMARY, p)).r; await sleep(2000);
      // tiebreak 3차 호출이 quota/transient 로 null 이면 판정 미완 → 캐시 말고 다음 run 재시도.
      // (보수적 banned 영구캐시 방지 — tiebreaker 가 실제로 투표할 기회를 보장. one-null 동류.)
      if (!r3) { continue; }
    }
    const tiebreakRestricted = isSplit && r3?.verdict === "restricted" && hi(r3);
    decisions[k] = {
      inci: ig.inci_name, ko: ig.korean_name, country: r.country_code,
      m1: r1 ?? null, m2: r2 ?? null, m3: r3 ?? null,
      verdict: (consensusRestricted || tiebreakRestricted) ? "restricted"
        : (r1?.verdict === "banned" || r2?.verdict === "banned" ? "banned" : "uncertain"),
      by: tiebreakRestricted ? "gemini-tiebreak" : "gemini-consensus",
    };
    judged++;
    if (judged % 3 === 0) { console.log(`  판단 ${judged}...`); writeFileSync(DECISIONS, JSON.stringify({ generated: "status-judge", decisions }, null, 2)); }
  }
  writeFileSync(DECISIONS, JSON.stringify({ generated: "status-judge", decisions }, null, 2));

  // override = consensus 'restricted' 만. (banned→restricted 교정, MFDS 출처행 한정.)
  const corrections = Object.entries(decisions)
    .filter(([, d]) => (d as { verdict: string }).verdict === "restricted")
    .map(([k, d]) => {
      const [ingredient_id, country_code] = k.split(":");
      const dd = d as { inci: string; ko: string | null; m1?: { reason?: string } | null };
      return {
        ingredient_id, country_code, from: "banned", to: "restricted",
        source_match: SOURCE_MATCH, inci: dd.inci, ko: dd.ko,
        reason: dd.m1?.reason ?? "Gemini dual-consensus: 사용제한(제한) 자료가 banned 로 오분류",
      };
    });
  writeFileSync(OVERRIDES, JSON.stringify({
    generated: "status-judge",
    note: "Gemini 듀얼 consensus 로 'restricted' 확정된 banned 오분류 교정(data-loader 가 row.status 교정). 금지annex veto·uncertain 은 제외=검토큐(status-decisions.json).",
    corrections,
  }, null, 2));

  const counts = { restricted: 0, banned: 0, uncertain: 0 } as Record<string, number>;
  for (const d of Object.values(decisions)) counts[(d as { verdict: string }).verdict]++;
  console.log(`✓ 판단: 신규 ${judged} · 캐시 ${cached} · veto ${vetoed}`);
  console.log(`  결과 분포: restricted ${counts.restricted} · banned ${counts.banned} · uncertain ${counts.uncertain}`);
  console.log(`  교정 override: ${corrections.length}`);
}
main();
