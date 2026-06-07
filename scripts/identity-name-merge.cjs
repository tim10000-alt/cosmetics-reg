#!/usr/bin/env node
// identity 분절 병합(결정론·자가치유) — byte-동일 inci_name 으로 쪼개진 *동일물질* 다중 entry 통합.
// 안전조건(전부 충족): ① inci_name trim 완전동일 ② CAS 양립(유효 CAS 가 정확히 1개로 합의 OR 전부 無)
//   ③ korean_name 양립(distinct 0~1종). **CAS 충돌(menthol 이성질·sodium borate 수화물 등)=다른 form
//   가능 → 병합금지(분별력).** 대표=reg 최다(동률시 CAS有>korean有>id순). 나머지 regs 대표로 이전
//   (국가+출처+status+조건 중복제거)·synonyms/korean/cas 보강·중복 ingredient 제거. 멱등.
// 사용: node scripts/identity-name-merge.cjs [--apply]
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "..", "public", "data");
const REGDIR = path.join(DATA, "regulations");
const apply = process.argv[2] === "--apply";
const validCas = (c) => [...new Set(String(c || "").match(/\d{2,7}-\d{2}-\d/g) || [])];

const ingObj = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8"));
const ingredients = ingObj.rows;
const regFiles = fs.readdirSync(REGDIR).filter((f) => f.endsWith(".json"));
const regByFile = {}, regsByIng = new Map();
for (const f of regFiles) {
  const obj = JSON.parse(fs.readFileSync(path.join(REGDIR, f), "utf8"));
  regByFile[f] = obj;
  for (const r of obj.rows) (regsByIng.get(r.ingredient_id) || regsByIng.set(r.ingredient_id, []).get(r.ingredient_id)).push(r);
}
const nReg = (id) => (regsByIng.get(id) || []).length;

// 그룹: byte-동일 inci_name
const groups = new Map();
for (const i of ingredients) { const n = (i.inci_name || "").trim(); if (!n) continue; (groups.get(n) || groups.set(n, []).get(n)).push(i); }

let merged = 0, regsMoved = 0, regsDedup = 0, skipCasConflict = 0, skipKoConflict = 0;
const removeIds = new Set();
const log = [];
for (const [name, g] of groups) {
  if (g.length < 2) continue;
  const cas = [...new Set(g.flatMap((i) => validCas(i.cas_no)))];
  if (cas.length > 1) { skipCasConflict++; if (log.length < 8) log.push(`  ~ skip CAS충돌: "${name.slice(0, 30)}" [${cas.slice(0, 3).join(",")}]`); continue; }
  const kos = [...new Set(g.map((i) => (i.korean_name || "").trim()).filter(Boolean))];
  if (kos.length > 1) { skipKoConflict++; continue; }
  // 대표: reg 최다 → CAS有 → korean有 → id 사전순
  const target = g.slice().sort((a, b) => nReg(b.id) - nReg(a.id) || validCas(b.cas_no).length - validCas(a.cas_no).length || (b.korean_name ? 1 : 0) - (a.korean_name ? 1 : 0) || (a.id < b.id ? -1 : 1))[0];
  const existing = new Set((regsByIng.get(target.id) || []).map((r) => r.country_code + "|@|" + r.source_document + "|@|" + r.status + "|@|" + (r.conditions || "")));
  for (const i of g) {
    if (i.id === target.id) continue;
    for (const r of (regsByIng.get(i.id) || [])) {
      const k = r.country_code + "|@|" + r.source_document + "|@|" + r.status + "|@|" + (r.conditions || "");
      if (existing.has(k)) { r.__drop = true; regsDedup++; continue; }
      r.ingredient_id = target.id; existing.add(k); regsMoved++;
    }
    // 보강: korean/cas/synonyms
    if (!target.korean_name && i.korean_name) target.korean_name = i.korean_name;
    if (!validCas(target.cas_no).length && validCas(i.cas_no).length) target.cas_no = i.cas_no;
    if (!target.synonyms) target.synonyms = [];
    for (const s of (i.synonyms || [])) if (!target.synonyms.includes(s)) target.synonyms.push(s);
    removeIds.add(i.id);
    merged++;
  }
}
const newIngredients = ingredients.filter((i) => !removeIds.has(i.id));
for (const f of regFiles) regByFile[f].rows = regByFile[f].rows.filter((r) => !r.__drop);

console.log(`identity 분절병합: 중복성분 제거 ${merged} · regs이전 ${regsMoved} · 중복폐기 ${regsDedup} · skip(CAS충돌 ${skipCasConflict}, korean충돌 ${skipKoConflict})`);
log.forEach((x) => console.log(x));
console.log(`ingredients ${ingredients.length} -> ${newIngredients.length}`);
if (apply && merged > 0) {
  ingObj.rows = newIngredients;
  fs.writeFileSync(path.join(DATA, "ingredients.json"), JSON.stringify(ingObj));
  for (const f of regFiles) fs.writeFileSync(path.join(REGDIR, f), JSON.stringify(regByFile[f]));
  try { const m = JSON.parse(fs.readFileSync(path.join(DATA, "meta.json"), "utf8")); if (m.counts) { m.counts.ingredients = newIngredients.length; fs.writeFileSync(path.join(DATA, "meta.json"), JSON.stringify(m, null, 2)); } } catch {}
  console.log("적용 완료.");
} else if (!apply) console.log("(dry-run)");
