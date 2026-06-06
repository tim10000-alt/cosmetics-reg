#!/usr/bin/env node
// Claude 직접 판정기(초기 백로그 벌크) — 무료 Gemini 일일한도로 못 도는 banned↔restricted 오분류를
// *conditions 원문 근거*로 분류(내 기억 아님, 15차 교훈). 보수적: restricted 는 conditions 에
// *제품/용도별 허용농도*가 명확할 때만. 일반한도(파라벤 "단일성분 0.4%")·색소 등재조항·금지문구·
// 애매 = banned 유지. 권위 금지annex veto 병행(이중안전). 출처 by:"claude-judge"(Gemini 와 구분).
// 검증모드(--validate): 이미 판정된 Gemini verdict 와 일치도 측정. 생성모드(--apply): overrides 갱신.
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "..", "public", "data");
const REG = path.join(DATA, "regulations");
const J = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

// 제품/용도 키워드(KR/CN 번역 원문) + 농도 + 허용맥락. 색소 단서조항(농도 없는 등재규칙)은 제외됨.
const PRODUCT = /두발|모발|염모|탈[염색]|퍼[머마]|파마|피부|손발톱|손톱|네일|세정|세안|면도|구강|치약|데오도|자외선|선스크린|메이크업|영유아|제품류|제품에서|제품\s*중|화장품에|oral|hair|skin|nail|rinse|leave|cosmetic/i;
const CONC = /\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:g|mg|ppm)\b/;
const ALLOW = /(적용|사용범위|사용 가능|허용|배합한도|최대\s*사용\s*농도|최대사용농도|사용할 수 있|준용|참조)/;

// conditions 원문 기반 분류(veto 는 호출측에서 별도 적용 — 진짜 금지 차단).
// restricted IF: 허용 맥락(배합한도/사용범위/허용) + 실제 농도값. 색소 단서조항(농도 없음)·순수
// 금지문구·애매 = banned. 제품별 한정은 불필요(보존제 등 일반 허용한도도 restricted). PRODUCT 는
// 참고용(제품맥락 있으면 확신↑)이나 필수 아님.
function classify(cond) {
  if (!cond) return { v: "banned", why: "조건없음" };
  const allow = ALLOW.test(cond), conc = CONC.test(cond), prod = PRODUCT.test(cond);
  if (allow && conc) return { v: "restricted", why: prod ? "제품/용도별 허용농도 명시" : "허용 배합한도(농도) 명시" };
  return { v: "banned", why: "허용농도 없음(색소조항/금지문구/애매)" };
}

const validCas = (raw) => String(raw || "").match(/\d{2,7}-\d{2}-\d/g) || [];
const canon = (s) => s.toLowerCase().replace(/[；;]/g, ",").replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").replace(/[,\s]*\(\s*cas[^)]*\)/g, "").replace(/[,\s]+c\.?i\.?\s*\d{4,6}/g, "").replace(/[,\s]+$/, "").trim();
const PROHIB = /Annex II|Prohibited|California AB|표1[^\n]*금지|사용 금지 물질|Comunidad Andina|EUR-Lex 1223/i;
// 허용/한도 신호 — 국가별 형식 변형 포함(KR/CN "배합한도", JP "100g당 최대 배합/제품 타입 또는
// 목적", CA/US "【제한】/허용된 최대 농도(공백)", ASEAN "제한 사용범위"). narrow 만으로 타국 누락됐었음.
const LIMIT = /배합한도|최대\s*사용\s*농도|허용된\s*최대\s*농도|【제한\s*[】:：]|제한\s*【사용\s*범위|100\s*g\s*당\s*최대\s*배합|maximum theoretical concentration|산화형 염모제에 염색/;
// 조건부 금지(오염물/불순물 임계치 = 진짜 금지, 허용 아님) — 후보에서 제외(석유·부타디엔·DMSO 등).
const CONTAM_BAN = /함유하는 경우에 한함|contain[s]?\s*[>=]|초과하여 함유|불순물|impurit|w\/w\s+(?:Butadiene|DMSO|benzo)/i;
// 중금속/고독성 명시 veto — stale 미량한도(예 수은 0.007%)여도 사실상 금지라 절대 restricted 금지.
// 권위 annex 가 cas-null/동명변형으로 못 잡는 누수 차단(분별력 안전망). 이름 기반(보수적·광범위).
// 명백히 *항상 금지*인 중금속/독성(화장품 restricted 용도 없음)만. selenium(Selenium Sulfide
// 비듬약 restricted)·strontium(Thioglycolate 제모제)·zirconium(Al-Zr 발한억제)·naphthalene
// (naphthalenediol 염모제)·benzene 은 restricted 용도 있거나 CAS-annex veto 가 처리하므로 제외(오veto 방지).
const TOXIC = /mercur|수은|水銀|thimerosal|치메로살|thallium|탈륨|arsenic|비소|砷|cadmium|카드뮴|鎘|lead acetate|연\s*아세|beryll|베릴/i;

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
  // siblingIds(canonName + CAS) — 헤드라인은 형제 규제를 병합하므로 권위 출처 판정도 형제 포함.
  const nameToIds = new Map(), casToIds = new Map();
  const push2 = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const i of ing) { const cn = i.inci_name ? canon(i.inci_name) : ""; if (cn) push2(nameToIds, cn, i.id); for (const c of validCas(i.cas_no)) push2(casToIds, c, i.id); }
  const siblings = (id) => { const i = byId.get(id); const s = new Set([id]); if (!i) return s; const cn = i.inci_name ? canon(i.inci_name) : ""; if (cn) for (const x of nameToIds.get(cn) || []) s.add(x); for (const c of validCas(i.cas_no)) for (const x of casToIds.get(c) || []) s.add(x); return s; };
  // 같은 국가에 *더 높은 우선순위(>50)의 비-MFDS banned* 출처(형제 포함)가 있으면 그 권위 출처가
  // 헤드라인=banned 를 결정 → MFDS(50) 행을 restricted 로 교정하면 안 됨(예: TW Pyridine=TFDA 금지).
  const authBanned = (id, cc) => {
    const sib = siblings(id);
    return all.some((r) => sib.has(r.ingredient_id) && r.country_code === cc && r.status === "banned" && (r.source_priority || 0) > 50 && !(r.source_document || "").includes("MFDS"));
  };
  return { ing, byId, all, vetoed, authBanned };
}

function candidates(all, countries) {
  return all.filter((r) => countries.includes(r.country_code) && r.status === "banned" && (r.source_document || "").includes("MFDS") && r.conditions && LIMIT.test(r.conditions) && !CONTAM_BAN.test(r.conditions));
}

if (require.main === module) {
  const mode = process.argv[2] || "--validate";
  const { byId, all, vetoed, authBanned } = load();
  const dec = (() => { try { return J("status-decisions.json").decisions; } catch { return {}; } })();

  if (mode === "--validate") {
    let agree = 0, disagree = 0; const dis = [];
    for (const k in dec) {
      const x = dec[k];
      if (x.by !== "gemini-consensus" && x.by !== "gemini-tiebreak") continue;
      const [id, cc] = k.split(":");
      const r = all.find((rr) => rr.ingredient_id === id && rr.country_code === cc);
      if (!r) continue;
      const ig = byId.get(id);
      const c = (ig && vetoed(ig)) ? "banned" : classify(r.conditions).v;   // veto 우선(진짜 금지)
      const gem = x.verdict === "restricted" ? "restricted" : "banned";
      if (c === gem) agree++; else { disagree++; dis.push(`${x.inci}: 분류기=${c} vs Gemini=${x.verdict} | cond="${(r.conditions||"").replace(/\n/g," ").slice(0,90)}"`); }
    }
    console.log(`검증 — 이미판정 Gemini 대비 일치 ${agree} · 불일치 ${disagree}`);
    dis.forEach((d) => console.log("  ⚠ " + d));
    return;
  }

  if (mode === "--apply") {
    const countries = (process.argv[3] || "KR,CN,TW").split(",");
    const ovFile = path.join(DATA, "status-overrides.json");
    const ov = JSON.parse(fs.readFileSync(ovFile, "utf8"));
    const existing = new Set(ov.corrections.map((c) => `${c.ingredient_id}:${c.country_code}`));
    const decFile = path.join(DATA, "status-decisions.json");
    const decObj = JSON.parse(fs.readFileSync(decFile, "utf8"));
    let added = 0, vetoSkip = 0, keptBanned = 0, alreadyDec = 0;
    for (const r of candidates(all, countries)) {
      const key = `${r.ingredient_id}:${r.country_code}`;
      if (dec[key] || existing.has(key)) { alreadyDec++; continue; }
      const ig = byId.get(r.ingredient_id);
      if (!ig) continue;
      if (vetoed(ig)) { decObj.decisions[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict: "banned", by: "prohibition-veto" }; vetoSkip++; continue; }
      // 같은 국가 권위 출처(TFDA/IECIC 등 prio>50)가 banned 면 그게 헤드라인=금지 → MFDS 행 교정 금지.
      if (authBanned(r.ingredient_id, r.country_code)) { decObj.decisions[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict: "banned", by: "authoritative-ban" }; vetoSkip++; continue; }
      const cls = classify(r.conditions);
      if (cls.v === "restricted") {
        ov.corrections.push({ ingredient_id: r.ingredient_id, country_code: r.country_code, from: "banned", to: "restricted", source_match: "MFDS", inci: ig.inci_name, ko: ig.korean_name, reason: `claude-judge: ${cls.why}` });
        decObj.decisions[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict: "restricted", by: "claude-judge", why: cls.why };
        added++;
      } else {
        decObj.decisions[key] = { inci: ig.inci_name, ko: ig.korean_name, country: r.country_code, verdict: "banned", by: "claude-judge", why: cls.why };
        keptBanned++;
      }
    }
    fs.writeFileSync(ovFile, JSON.stringify(ov, null, 2));
    fs.writeFileSync(decFile, JSON.stringify({ generated: "status-judge", decisions: decObj.decisions }, null, 2));
    console.log(`적용 — 교정추가(restricted) ${added} · banned유지 ${keptBanned} · veto ${vetoSkip} · 기존 ${alreadyDec}`);
    console.log(`총 교정: ${ov.corrections.length}`);
  }
}
module.exports = { classify };
