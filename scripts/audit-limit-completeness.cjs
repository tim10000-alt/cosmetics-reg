#!/usr/bin/env node
// 한도 완전성 audit (재발방지) — "배합한도/용도구조는 있는데 한도 숫자가 *어디에도* 없는"
// 행(징크옥사이드형 데이터 누락)을 ingredient×country 단위로 검출. 정량 한도가 있어야 마땅한데
// 비어 있는 케이스를 자동 표면화 → limit-overrides 로 보강. 새로 늘면 경보(baseline 비교).
//
// 분별력: 질적 제한(염모용에만·흡입금지)·비-% 한도(과산화물가 mmoles/L)·조성임계값은 정상이므로
// 제외. 오직 "<용도> 또는 배합한도 라벨 + 어떤 단위 숫자도 0" 만 누락 의심.
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "..", "public", "data");
const REG = path.join(DATA, "regulations");
const BASELINE = path.join(DATA, "limit-completeness-baseline.json");

const ing = new Map(JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8")).rows.map((i) => [i.id, i]));
// 어떤 단위든 정량 값(유럽식 콤마 소수 "0,1 %" 포함 — 미포함 시 향료/잔류한도 거짓 누락).
const NUM_UNIT = /\d+(?:[.,]\d+)?\s*(%|ppm|ppb|mmol|mg|µg|g\/|mL|nm|배)/i;
// 정량 한도가 *있어야 마땅한* 용도 구조: 배합한도+<용도>(징크형), 또는 <자외선차단성분/제>·
// <보존제>(이 용도는 항상 % 한도 보유 — TiO2 형: 배합한도 라벨 없이 <자외선차단제>만 있는 경우도 포착).
// 일반 "<제한>"·<색소>(질적 용도제한 가능)·향료 알레르겐 라벨링은 제외(분별력).
const CAT_OR_LIMIT = /배합한도\s*[:：][^\n]*<[^>]+>|최대사용농도|<\s*자외선차단|<\s*보존제\s*>/;

const flagged = [];
for (const f of fs.readdirSync(REG).filter((x) => x.endsWith(".json"))) {
  const cc = f.slice(0, -5);
  const rows = JSON.parse(fs.readFileSync(path.join(REG, f), "utf8")).rows;
  // 형제(같은 CAS) 묶음×country 로 그룹 — 앱이 siblingIds 로 병합 표시하므로, 형제 중 *하나라도*
  // 한도 숫자를 가지면 OK(예: override 가 다른 형제 id 에 붙어도 표시엔 반영됨). CAS 없으면 id.
  const firstCas = (id) => { const g = ing.get(id) || {}; const m = String(g.cas_no || "").match(/\d{2,7}-\d{2}-\d/); return m ? m[0] : "id:" + id; };
  const byIng = new Map();
  for (const r of rows) {
    if (r.country_code && r.country_code !== cc) continue;
    const k = firstCas(r.ingredient_id);
    const a = byIng.get(k) || []; a.push(r); byIng.set(k, a);
  }
  for (const [id, rs] of byIng) {
    const restricted = rs.some((r) => r.status === "restricted");
    if (!restricted) continue;
    // 정량 숫자 보유 OR 외부 표/별표로 한도를 위임(질적 한도=정당, 예 "표6 요구사항에 적합")하면 OK.
    const DEFERS = /표\s*\d|별표|Table|적합|기준에\s*따|규정에\s*따|참조/;
    const hasNum = rs.some((r) => r.max_concentration != null || NUM_UNIT.test(r.conditions || "") || DEFERS.test(r.conditions || ""));
    if (hasNum) continue;
    // 한도 숫자 0인데 용도구조/배합한도 라벨이 있어 *정량 한도가 있어야 마땅* → 누락 의심
    const impliesLimit = rs.some((r) => CAT_OR_LIMIT.test(r.conditions || ""));
    if (!impliesLimit) continue;
    const g = ing.get(rs[0].ingredient_id) || {};
    flagged.push({ cc, id, name: g.korean_name || g.inci_name || id });
  }
}

const perCc = {};
for (const x of flagged) perCc[x.cc] = (perCc[x.cc] || 0) + 1;
console.log(`▶ 한도 완전성 audit: 누락 의심 ${flagged.length}건`, JSON.stringify(perCc));
for (const x of flagged.slice(0, 30)) console.log(`  [${x.cc}] ${x.name}`);

// baseline 비교 — 증가 시 경보(재발/회귀 조기탐지). --write 로 baseline 갱신.
let base = {};
try { base = JSON.parse(fs.readFileSync(BASELINE, "utf8")).perCc || {}; } catch {}
const increases = Object.keys(perCc).filter((cc) => (perCc[cc] || 0) > (base[cc] || 0));
if (process.argv.includes("--write")) {
  fs.writeFileSync(BASELINE, JSON.stringify({ generated: "audit-limit-completeness", total: flagged.length, perCc }, null, 2));
  console.log("baseline 갱신");
} else if (increases.length) {
  console.error(`::warning::한도 완전성 회귀 — 누락 증가 국가: ${increases.map((cc) => `${cc} ${base[cc] || 0}→${perCc[cc]}`).join(", ")}. limit-overrides 보강 필요.`);
}
process.exit(0);
