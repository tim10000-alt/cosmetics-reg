#!/usr/bin/env node
// 색소 identity 병합(결정론·무료·자가치유) — 권위 1차 색소 데이터의 fragmentation 교정.
//
// 문제: us-cfr(21 CFR Part73/74)·andean(Comunidad Andina) fetcher 가 색소를 "D&C Red No. 34"
//   같은 *단독 색소명*으로 ingredient 생성 → MFDS 다국가 데이터가 붙은 검색가능 colorant
//   ("Deep Maroon, D&C Red No. 34, Red 34 Lake, CI 15880:1") 와 **다른 성분으로 분절**됨.
//   결과: ①검색 colorant 카드에 권위 US/Andean "listed"(허용) 가 안 보임(카드 불완전)
//        ②colors-positive-list 검출기의 foreign-permit 확증이 형제 부재로 실패 → 잘못 banned 유지.
//
// 교정: 단독 색소명 orphan 을 같은 색소 designation(접두 Ext./F + No.번호 정확)을 가진 *유일* colorant
//   (CI번호/복합명 보유=더 풍부)에 병합 — orphan 의 전 규제를 colorant 로 이전(국가+출처 중복 제거),
//   단독명을 synonym 에 추가, orphan ingredient 제거. **유일매칭만**(애매·무매칭 skip=분별력).
//   멱등(병합 후 orphan 사라져 재실행 0). 매 crawl 자가치유(fetcher 가 또 만들어도 재병합).
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "..", "public", "data");
const REGDIR = path.join(DATA, "regulations");
const apply = process.argv[2] === "--apply";

const CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const TOKEN = /(Ext\.?\s*)?(F?D&C)\s+(Red|Green|Blue|Yellow|Orange|Violet|Brown|Black)\s+No\.?\s*(\d+)/gi;
function colorTokens(s) {
  const out = new Set(); let m; const re = new RegExp(TOKEN);
  while ((m = re.exec(s || ""))) out.add((m[1] ? "Ext. " : "") + m[2].toUpperCase() + " " + CAP(m[3]) + " No. " + m[4]);
  return out;
}
// 이름이 단일 색소 designation 만으로 이뤄짐 = fetcher 가 만든 orphan 후보
function isPureColorName(inci) {
  const t = colorTokens(inci);
  return t.size === 1 && [...t][0] === (inci || "").trim().replace(/\s+/g, " ").replace(/No\.\s*/, "No. ");
}

// ── load ──
const ingObj = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8"));
const ingredients = ingObj.rows;
const regFiles = fs.readdirSync(REGDIR).filter((f) => f.endsWith(".json"));
const regByFile = {};            // cc.json -> {rows, ...wrapper}
const regsByIng = new Map();     // ingredient_id -> [{file, reg}]
for (const f of regFiles) {
  const obj = JSON.parse(fs.readFileSync(path.join(REGDIR, f), "utf8"));
  regByFile[f] = obj;
  for (const r of obj.rows) {
    const a = regsByIng.get(r.ingredient_id) || regsByIng.set(r.ingredient_id, []).get(r.ingredient_id);
    a.push({ file: f, reg: r });
  }
}

// ── orphans + colorant index ──
const orphans = ingredients.filter((i) => isPureColorName(i.inci_name));
const colorants = ingredients.filter((i) => !isPureColorName(i.inci_name));
// token -> [colorant] (정확 토큰 보유 검색가능 성분)
const tokToColorants = new Map();
for (const c of colorants) {
  for (const tk of colorTokens((c.inci_name || "") + " ; " + (c.synonyms || []).join(" ; "))) {
    (tokToColorants.get(tk) || tokToColorants.set(tk, []).get(tk)).push(c);
  }
}

let merged = 0, skippedAmbig = 0, skippedNone = 0, regsMoved = 0, regsDedup = 0;
const removeIds = new Set();
const log = [];
for (const o of orphans) {
  const tok = [...colorTokens(o.inci_name)][0];
  const targets = (tokToColorants.get(tok) || []).filter((c) => c.id !== o.id);
  if (targets.length === 0) { skippedNone++; continue; }
  if (targets.length > 1) { skippedAmbig++; log.push(`  ~ skip(ambiguous ${targets.length}): ${tok}`); continue; }
  const target = targets[0];
  // colorant 의 기존 (country, source_document) 집합 — 중복 방지
  const existing = new Set((regsByIng.get(target.id) || []).map((x) => x.reg.country_code + "||" + x.reg.source_document));
  let movedThis = 0, dedupThis = 0;
  for (const { reg } of (regsByIng.get(o.id) || [])) {
    const key = reg.country_code + "||" + reg.source_document;
    if (existing.has(key)) { reg.__drop = true; dedupThis++; continue; } // colorant 가 이미 동일 출처 보유 → orphan reg 폐기
    reg.ingredient_id = target.id;   // 이전
    existing.add(key);
    movedThis++;
  }
  // 단독명을 synonym 에 추가(검색 도달)
  if (!target.synonyms) target.synonyms = [];
  if (!target.synonyms.includes(o.inci_name) && !(target.inci_name || "").includes(o.inci_name)) target.synonyms.push(o.inci_name);
  removeIds.add(o.id);
  merged++; regsMoved += movedThis; regsDedup += dedupThis;
  log.push(`  + ${tok}: regs ${movedThis} 이전${dedupThis ? ` (중복 ${dedupThis} 폐기)` : ""} -> "${(target.inci_name || "").slice(0, 46)}"`);
}

// ── 적용: reg rows 재작성(__drop 제거, ingredient_id 재지정 반영) + orphan ingredient 제거 ──
const newIngredients = ingredients.filter((i) => !removeIds.has(i.id));
for (const f of regFiles) regByFile[f].rows = regByFile[f].rows.filter((r) => !r.__drop);

console.log(`색소 identity 병합: merged ${merged} · regs이전 ${regsMoved} · 중복폐기 ${regsDedup} · skip(ambiguous ${skippedAmbig}, none ${skippedNone})`);
log.forEach((x) => console.log(x));
console.log(`ingredients ${ingredients.length} -> ${newIngredients.length} (orphan 제거 ${removeIds.size})`);

if (apply && merged > 0) {
  ingObj.rows = newIngredients;
  fs.writeFileSync(path.join(DATA, "ingredients.json"), JSON.stringify(ingObj));
  for (const f of regFiles) fs.writeFileSync(path.join(REGDIR, f), JSON.stringify(regByFile[f]));
  console.log("적용 완료.");
} else if (!apply) console.log("(dry-run — --apply 로 적용)");
