#!/usr/bin/env node
// 색소 positive-list 오태깅 교정(전국가 일반화) — MFDS 공공데이터가 각국 *화장품 허용색소표*(着色劑
// positive-list)를 "사용제한=banned" 로 오태깅한 행을 실제 status(listed/restricted)로 복원.
// tw-color-listed.cjs 와 동일 분별력 5중 안전망(전부 통과해야 교정):
//   ① 색소 positive-list 신호(국가별: TW 所列色素 / CN 着色劑사용허가 / ASEAN Colouring agents allowed
//      / JP 사용할수있는색소) ② veto(수은/금속/금지annex) ③ authBanned(권위 prio>50 banned 형제)
//      ④ 19금지 CI 블록 ⑤ foreign-permit 확증(EU/JP/CN-NMPA/US 형제가 listed|restricted).
// 농도값 보유 = restricted, 없음 = listed. by:"claude-color"(status-judge.ts 재생성 보존).
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "..", "public", "data");
const REG = path.join(DATA, "regulations");
const J = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

// 색소 positive-list 신호(허용표 출처). prohibition list 가 아닌 *허용* 맥락만.
const POSCOLOR = /所列色素|麗基|准予使用|착색제\s*【?\s*사용\s*허가|Colou?ring agents? allowed|사용\s*할\s*수\s*있는\s*색소|allowed in all cosmetic|Field of application\s*:\s*Colou?r|화장품에 사용 할 수 있는 색소|점막에 사용되지 않는[^】]*색소/i;
const CONC = /\d+(?:\.\d+)?\s*%/;
const PROHIB = /Annex II|Prohibited|California AB|표1[^\n]*금지|사용 금지 물질|Comunidad Andina|EUR-Lex 1223/i;
const TOXIC = /mercur|수은|水銀|thimerosal|치메로살|thallium|탈륨|arsenic|비소|砷|cadmium|카드뮴|鎘|lead acetate|연\s*아세|beryll|베릴/i;
const BANNED19 = new Set(["11380","11390","12100","12150","12170","13065","18130","26100","42535","44025","44045","61554","73312","10316","12085","15585","73000"]);

const validCas = (raw) => String(raw || "").match(/\d{2,7}-\d{2}-\d/g) || [];
const canon = (s) => s.toLowerCase().replace(/[；;]/g, ",").replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").replace(/[,\s]*\(\s*cas[^)]*\)/g, "").replace(/[,\s]+c\.?i\.?\s*\d{4,6}/g, "").replace(/[,\s]+$/, "").trim();

function load() {
  const ing = J("ingredients.json").rows;
  const byId = new Map(ing.map((i) => [i.id, i]));
  const all = [];
  for (const f of fs.readdirSync(REG).filter((x) => x.endsWith(".json"))) all.push(...JSON.parse(fs.readFileSync(path.join(REG, f), "utf8")).rows);
  const banId = new Set(), banCas = new Set(), banName = new Set();
  for (const r of all) {
    if (r.status !== "banned" || !PROHIB.test(`${r.source_document || ""} ${r.conditions || ""}`)) continue;
    banId.add(r.ingredient_id);
    const ig = byId.get(r.ingredient_id);
    if (ig) { for (const c of validCas(ig.cas_no)) banCas.add(c); if (ig.inci_name) banName.add(canon(ig.inci_name)); }
  }
  const vetoed = (ig) => banId.has(ig.id) || validCas(ig.cas_no).some((c) => banCas.has(c)) || (ig.inci_name && banName.has(canon(ig.inci_name))) || (ig.inci_name && TOXIC.test(ig.inci_name));
  const nameToIds = new Map(), casToIds = new Map();
  const push2 = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const i of ing) { const cn = i.inci_name ? canon(i.inci_name) : ""; if (cn) push2(nameToIds, cn, i.id); for (const c of validCas(i.cas_no)) push2(casToIds, c, i.id); }
  const siblings = (id) => { const i = byId.get(id); const s = new Set([id]); if (!i) return s; const cn = i.inci_name ? canon(i.inci_name) : ""; if (cn) for (const x of nameToIds.get(cn) || []) s.add(x); for (const c of validCas(i.cas_no)) for (const x of casToIds.get(c) || []) s.add(x); return s; };
  const authBanned = (id, cc) => { const s = siblings(id); return all.some((r) => s.has(r.ingredient_id) && r.country_code === cc && r.status === "banned" && (r.source_priority || 0) > 50 && !(r.source_document || "").includes("MFDS")); };
  const foreignPermit = (id) => { const s = siblings(id); return all.some((r) => s.has(r.ingredient_id) && ["EU", "JP", "CN", "US"].includes(r.country_code) && (r.status === "listed" || r.status === "restricted") && (/IECIC|NMPA|EU|MHLW|JCIA|positive|Annex (IV|V|VI)|21 ?CFR/i.test(r.source_document || "") || r.country_code === "EU")); };
  return { ing, byId, all, vetoed, authBanned, foreignPermit };
}

if (require.main === module) {
  const apply = process.argv[2] === "--apply";
  const { byId, all, vetoed, authBanned, foreignPermit } = load();
  const ovFile = path.join(DATA, "status-overrides.json");
  const ov = JSON.parse(fs.readFileSync(ovFile, "utf8"));
  const existing = new Set(ov.corrections.map((c) => `${c.ingredient_id}:${c.country_code}`));
  const decFile = path.join(DATA, "status-decisions.json");
  const decObj = JSON.parse(fs.readFileSync(decFile, "utf8"));
  const dec = decObj.decisions;

  const cand = all.filter((r) => r.status === "banned" && (r.source_document || "").includes("MFDS") && r.conditions && POSCOLOR.test(r.conditions));
  let listed = 0, restricted = 0, veto = 0, authBan = 0, ban19 = 0, noConf = 0, already = 0;
  const applied = [];
  for (const r of cand) {
    const key = `${r.ingredient_id}:${r.country_code}`;
    if (existing.has(key) || dec[key]) { already++; continue; }
    const ig = byId.get(r.ingredient_id);
    if (!ig) continue;
    if (vetoed(ig)) { dec[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict: "banned", by: "prohibition-veto" }; veto++; continue; }
    if (authBanned(r.ingredient_id, r.country_code)) { dec[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict: "banned", by: "authoritative-ban" }; authBan++; continue; }
    const ci = (ig.inci_name || "").match(/\b\d{4,6}\b/g) || [];
    if (ci.some((x) => BANNED19.has(x))) { dec[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict: "banned", by: "tfda-banned19-color" }; ban19++; continue; }
    if (!foreignPermit(r.ingredient_id)) { dec[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict: "banned", by: "claude-color", why: "외국허용 확증無 — 보류(검토큐)" }; noConf++; continue; }
    const verdict = CONC.test(r.conditions) ? "restricted" : "listed";
    ov.corrections.push({ ingredient_id: r.ingredient_id, country_code: r.country_code, from: "banned", to: verdict, source_match: "MFDS", inci: ig.inci_name, ko: ig.korean_name, reason: `claude-color: 화장품 허용색소표(着色劑 positive-list)가 사용제한으로 오태깅 — 외국(EU/JP/CN-NMPA/US) 허용확증${verdict === "restricted" ? " + 농도한도" : ""}` });
    dec[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict, by: "claude-color", why: "허용색소표 오태깅·외국허용확증", source_match: "MFDS" };
    applied.push(`${r.country_code} ${verdict} ${(ig.inci_name || "").slice(0, 34)}`);
    if (verdict === "listed") listed++; else restricted++;
  }

  console.log(`색소 positive-list 후보 ${cand.length} 중:`);
  console.log(`  ✅ →listed ${listed} · →restricted ${restricted}`);
  console.log(`  유지(banned): veto ${veto} · authBan ${authBan} · 19금지CI ${ban19} · 확증無보류 ${noConf} · 기존 ${already}`);
  console.log("\n적용 명세:"); applied.forEach((x) => console.log("  + " + x));
  if (apply) {
    fs.writeFileSync(ovFile, JSON.stringify(ov, null, 2));
    fs.writeFileSync(decFile, JSON.stringify({ generated: "status-judge", decisions: dec }, null, 2));
    console.log(`\n적용 완료 — 총 교정 ${ov.corrections.length}`);
  } else console.log("\n(dry-run — --apply 로 적용)");
}
