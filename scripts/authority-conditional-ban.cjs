#!/usr/bin/env node
// 권위(prio≥100) 금지목록의 *조건부-허용 금지*(물질 자체는 사용가능, 특정 불순/형태만 금지)를
// restricted 로 교정. 예: 중국 NMPA 표1 "Petrolatum(정제시 예외)"·"Butane(부타디엔≥0.1%만 금지)"
// ·"Methyl Eugenol(천연향료 함유분 제외)"·"Oxyquinoline(표3 용도 제외)". 헤드라인 severity 타이브레이크
// 와 결합 시 이들이 '배합금지'로 오도되지 않게 함(분별력: 보편 허용물질의 과대금지 방지).
// **제외(banned 유지)**: 미량-잔류 관용(물질 자체 사용불가, 잔류만 허용 — 예 diethylene glycol
// "비의도적 잔류물 0.1%↓") + veto(수은/금속/금지annex). source_match 로 금지행만 교정(허용행 무관).
const fs = require("fs");
const path = require("path");
const G = require("./verify-groundtruth.cjs");
const { bucketFor, siblingIds, ingredients, byId, countries } = G;
const DATA = path.join(__dirname, "..", "public", "data");

// 물질 자체가 *명확히* 사용가능함을 뜻하는 좁은 예외절만(과대확장·오판 방지). 3패턴:
//   ① 석유정제: "정제과정이 완전히 알려지고 비발암성이면 예외"(EU/CN CMR-if-unrefined 군)
//   ② 오염형태만 금지: "부타디엔 0.1%↑ 함유하는 부탄/이소부탄"(청정물질 사용가능)
//   ③ 천연함유분 제외: "천연향료 자연함유분 제외"(Methyl Eugenol·Safrole 등, restricted 한도有)
// 애매한 "exception of"(Barium/nitrites)·농약(Dinoseb)·표3참조 등은 제외 → banned 유지(보수).
const USABLE_EXC = /정제과정이 완전히 알려|除非清楚全部精炼|refining history is known|含量大于或等于\s*0[.,]1|0[.,]1\s*%\s*w\/w\s*이상\s*함유(?:하는)?\s*(?:부탄|이소부탄|아이소부탄)|if it contains ≥\s*0[.,]1\s*%\s*w\/w\s*Butadiene|天然香料含有的除外|normal content in the natural|자연적으로 함유되는|식물추출물에 의하여 자연적으로/i;
const RESIDUAL = /잔류물|residual|비의도적|unintentional|잔류\s*농도/i;
const TOXIC = /mercur|수은|水銀|thimerosal|치메로살|thallium|탈륨|arsenic|비소|砷|cadmium|카드뮴|鎘|lead acetate|연\s*아세|beryll|베릴/i;

const apply = process.argv[2] === "--apply";
const ovFile = path.join(DATA, "status-overrides.json");
const ov = JSON.parse(fs.readFileSync(ovFile, "utf8"));
const existing = new Set(ov.corrections.map((c) => `${c.ingredient_id}:${c.country_code}`));
const decFile = path.join(DATA, "status-decisions.json");
const decObj = JSON.parse(fs.readFileSync(decFile, "utf8"));
const dec = decObj.decisions;

const seen = new Set();
let added = 0, skipResidual = 0, skipVeto = 0;
const applied = [];
for (const ing of ingredients) {
  const ids = siblingIds.get(ing.id) ?? [ing.id];
  const repKey = [...ids].sort()[0];
  for (const c of countries) {
    const code = c.code;
    const k = repKey + "|" + code;
    if (seen.has(k)) continue;
    seen.add(k);
    const b = bucketFor(ids, code);
    if (!b || !b.length) continue;
    // 권위(prio≥100) 조건부-허용 금지행 찾기
    const ban = b.find((r) => r.status === "banned" && (r.source_priority ?? 0) >= 100 && USABLE_EXC.test(r.conditions || "") && !RESIDUAL.test(r.conditions || ""));
    if (!ban) continue;
    // 독립 sibling listed/restricted 확증(물질 usable)
    const usable = b.some((r) => (r.status === "listed" || r.status === "restricted") && r.source_document !== ban.source_document);
    if (!usable) continue;
    const ig = byId.get(ban.ingredient_id);
    if (!ig) continue;
    const key = `${ban.ingredient_id}:${code}`;
    if (existing.has(key)) continue;
    if (TOXIC.test(ig.inci_name || "")) { dec[key] = { inci: ig.inci_name, ko: ig.korean_name, country: code, verdict: "banned", by: "toxic-veto" }; skipVeto++; continue; }
    if (RESIDUAL.test(ban.conditions || "")) { skipResidual++; continue; }
    // source_match: 금지행 출처의 구분 토큰(표1/禁止/안전기술규범 등). 허용행은 from=banned 필터로 자동 제외.
    const sm = (ban.source_document || "").includes("화장품안전기술규범") ? "화장품안전기술규범"
      : (ban.source_document || "").includes("Annex II") ? "Annex II"
      : (ban.source_document || "").slice(0, 16);
    ov.corrections.push({ ingredient_id: ban.ingredient_id, country_code: code, from: "banned", to: "restricted", source_match: sm, inci: ig.inci_name, ko: ig.korean_name, reason: `claude-cond: 권위 금지목록의 조건부-허용 금지(물질 자체 사용가능, 특정 불순/형태만 금지) — restricted 교정. 원조건: ${(ban.conditions || "").replace(/\n/g, " ").slice(0, 80)}` });
    dec[key] = { inci: ig.inci_name, ko: ig.korean_name, country: code, verdict: "restricted", by: "claude-cond", why: "조건부-허용 authority-ban", source_match: sm };
    applied.push(`${code} ${(ig.inci_name || "").slice(0, 26)} [sm:${sm}]`);
    added++;
  }
}
console.log(`조건부-허용 authority-ban 교정: ${added} · residual제외 ${skipResidual} · veto ${skipVeto}`);
applied.forEach((x) => console.log("  + " + x));
if (apply) {
  fs.writeFileSync(ovFile, JSON.stringify(ov, null, 2));
  fs.writeFileSync(decFile, JSON.stringify({ generated: "status-judge", decisions: dec }, null, 2));
  console.log(`적용 — 총 교정 ${ov.corrections.length}`);
} else console.log("(dry-run)");
