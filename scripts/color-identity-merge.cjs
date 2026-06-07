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

// ── CI(Colour Index) 번호 identity (2차 pass) ──
// CI 번호는 색소의 권위 동일성 키(같은 단일 CI = 같은 색소). 단 ①접미(:1/:2=다른 lake)는 정확매칭
// ②복수 CI(group fragment)·③조건문 잔재 이름(parser artifact)은 위험 → 제외. "CI" 마커 동반 숫자만
// (bare 5자리 CAS 오인 방지).
const ciMarked = (s) => { const out = new Set(); const re = /\bC\.?\s?I\.?\s*(\d{5}(?::\d)?)\b/gi; let m; while ((m = re.exec(String(s || "")))) out.add(m[1]); return [...out]; };
const MFDS_SRC = /MFDS/;
const AUTH_COLOR = /21 ?CFR|Comunidad Andina|Annex IV|Annex VI|NMPA|IECIC|MHLW|ASEAN|positive list|착색|着色|色素/i;
const NAME_ARTIFACT = /when |and its| if |except|함유|제한|provided|용도|범위|기타|단서|salt.*\(/i;

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
// orphan 의 전 규제를 target 으로 이전(국가+출처 중복제거)·synonym 추가·orphan 제거.
function doMerge(o, target, tag) {
  const existing = new Set((regsByIng.get(target.id) || []).map((x) => x.reg.country_code + "||" + x.reg.source_document));
  let movedThis = 0, dedupThis = 0;
  for (const { reg } of (regsByIng.get(o.id) || [])) {
    const key = reg.country_code + "||" + reg.source_document;
    if (existing.has(key)) { reg.__drop = true; dedupThis++; continue; }
    reg.ingredient_id = target.id;
    existing.add(key);
    movedThis++;
  }
  if (!target.synonyms) target.synonyms = [];
  if (!target.synonyms.includes(o.inci_name) && !(target.inci_name || "").includes(o.inci_name)) target.synonyms.push(o.inci_name);
  removeIds.add(o.id);
  merged++; regsMoved += movedThis; regsDedup += dedupThis;
  log.push(`  + [${tag}] regs ${movedThis} 이전${dedupThis ? ` (중복 ${dedupThis} 폐기)` : ""}: "${(o.inci_name || "").slice(0, 32)}" -> "${(target.inci_name || "").slice(0, 40)}"`);
}

// 같은 토큰에 colorant 가 여럿이면(동일색소 중복 ingredient) — *모두 같은 CAS(=같은 물질)* 일 때만
// 대표(reg 최다)로 병합(분별력: CAS 불일치=다른물질 가능성→skip). 권위 listing(US 21CFR 등)이
// 중복 colorant 분절로 검색카드에 안 닿던 것 해소. (대표 외 중복은 CAS-sibling 이라 표시 통합됨.)
const casSet = (ig) => new Set(String(ig.cas_no || "").match(/\d{2,7}-\d{2}-\d/g) || []);
function pickTarget(targets, tag) {
  if (targets.length === 1) return targets[0];
  const sets = targets.map(casSet);
  const common = [...sets[0]].filter((c) => sets.every((s) => s.has(c)));
  if (!common.length) { skippedAmbig++; log.push(`  ~ skip(ambiguous ${targets.length}, CAS 불일치): ${tag}`); return null; }
  return targets.slice().sort((a, b) => (regsByIng.get(b.id) || []).length - (regsByIng.get(a.id) || []).length)[0];
}

// ── Pass 1: D&C/FD&C designation 토큰 ──
for (const o of orphans) {
  const tok = [...colorTokens(o.inci_name)][0];
  const targets = (tokToColorants.get(tok) || []).filter((c) => c.id !== o.id && !removeIds.has(c.id));
  if (targets.length === 0) { skippedNone++; continue; }
  const target = pickTarget(targets, tok);
  if (target) doMerge(o, target, tok);
}

// ── Pass 2: CI 번호 identity (단일 CI-marked thin → 유일 단일 CI rich target) ──
// thin = MFDS 없음 + 권위 색소 reg 보유 + 단일 CI-marked + non-artifact 이름. rich = MFDS 보유.
const hasMfds = (id) => (regsByIng.get(id) || []).some((x) => MFDS_SRC.test(x.reg.source_document || ""));
const hasAuthColor = (id) => (regsByIng.get(id) || []).some((x) => AUTH_COLOR.test((x.reg.source_document || "") + " " + (x.reg.conditions || "")));
const ciToRich = new Map();
for (const c of ingredients) {
  if (removeIds.has(c.id) || !hasMfds(c.id)) continue;
  const cis = ciMarked(c.inci_name);
  if (cis.length !== 1) continue;           // 단일 CI rich target 만(group 위험 제외)
  (ciToRich.get(cis[0]) || ciToRich.set(cis[0], []).get(cis[0])).push(c);
}
for (const o of ingredients) {
  if (removeIds.has(o.id) || hasMfds(o.id) || !hasAuthColor(o.id)) continue;
  if (NAME_ARTIFACT.test(o.inci_name || "")) continue;        // 조건문 잔재 이름 제외(분별력)
  const cis = ciMarked(o.inci_name);
  if (cis.length !== 1) continue;                              // 복수 CI fragment 제외
  const targets = (ciToRich.get(cis[0]) || []).filter((c) => c.id !== o.id && !removeIds.has(c.id));
  if (targets.length !== 1) { if (targets.length > 1) skippedAmbig++; continue; }
  doMerge(o, targets[0], "CI " + cis[0]);
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
  // meta.json 성분 카운트 동기화 — us:colors 가 merge 전 카운트로 써둔 것을 orphan 제거 반영해 갱신
  // (안 하면 부제목 성분수가 매일 merge 제거분만큼 stale). regs 는 불변(이전만)이라 그대로.
  try {
    const metaPath = path.join(DATA, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.counts) { meta.counts.ingredients = newIngredients.length; fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); }
  } catch {}
  console.log("적용 완료.");
} else if (!apply) console.log("(dry-run — --apply 로 적용)");
