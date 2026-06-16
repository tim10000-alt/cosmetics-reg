// 예방(일반·결정론·無Gemini·자동수정 안 함) — identity 분절로 인한 status 충돌을 전 국가에서
// 조기 표면화. 같은 CAS(동일물질)인데 한 ingredient 카드는 'banned' 헤드라인, 다른 카드는
// 'restricted/listed'(허용) 헤드라인이면, 사용자가 검색한 카드에 따라 금지/허용이 엇갈려 보임
// = false-banned 또는 false-allowed 씨앗(이번 JP 징크피리치온형). MFDS 중계 분절행이 자국
// 권위 positive-list 와 어긋날 때 주로 발생.
//
// 자동수정 안 함(분별력): 진짜 per-use 차이(예: 같은물질이라도 form/염이 다르면 규제 다를 수 있음)나
// 정당한 권위차일 수 있어 limit-overrides 로 사람이 판단해 교정. 이 스크립트는 review-queue 생성 +
// baseline 대비 신규 충돌 급증 시 경보(파서 regression/신규 분절 조기 발견).
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "..", "public", "data");
const REGDIR = path.join(DATA, "regulations");
const OUT = path.join(DATA, "status-conflicts.json");

const normCas = (c) => String(c || "").split(/[\s,;/]+/).map((s) => s.trim().replace(/\(.*$/, "")).filter(Boolean);
const ALLOW = new Set(["restricted", "listed", "allowed"]);

function main() {
  const write = process.argv.includes("--write");
  const ings = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8")).rows;
  const ingById = new Map(ings.map((i) => [i.id, i]));
  // CAS → ingredient ids (분절 그룹)
  const casToIds = new Map();
  for (const i of ings) for (const c of normCas(i.cas_no)) (casToIds.get(c) || casToIds.set(c, []).get(c)).push(i.id);

  const headline = (rows) => rows.length ? rows.reduce((a, b) => ((b.source_priority || 0) > (a.source_priority || 0) ? b : a)) : null;

  const conflicts = [];
  for (const f of fs.readdirSync(REGDIR).filter((x) => x.endsWith(".json"))) {
    const cc = f.replace(".json", "");
    const byId = {};
    for (const r of JSON.parse(fs.readFileSync(path.join(REGDIR, f), "utf8")).rows) (byId[r.ingredient_id] ||= []).push(r);
    const seen = new Set();
    for (const [cas, ids] of casToIds) {
      if (ids.length < 2) continue;
      const heads = [];
      for (const id of ids) { const h = headline(byId[id] || []); if (h) heads.push({ id, status: h.status, prio: h.source_priority || 0, src: h.source_document || "" }); }
      const hasBan = heads.some((h) => h.status === "banned");
      const hasAllow = heads.some((h) => ALLOW.has(h.status));
      if (hasBan && hasAllow) {
        const key = cc + "|" + cas;
        if (seen.has(key)) continue; seen.add(key);
        const bannedHeads = heads.filter((h) => h.status === "banned");
        // override(prio110)로 이미 교정된 충돌은 제외(헤드라인이 override면 OK)
        if (bannedHeads.every((h) => h.src === "Claude 원문대조 추출")) continue;
        // 카테고리 금지(예 "X and its compounds/salts/derivatives", "수은화합물")는 특정 멤버가
        // restricted 여도 정당한 per-use → 노이즈 제외(분별력). 특정물질 충돌만 actionable.
        const CAT = /and its|compound|derivativ|\bsalts?\b|류$|화합물|제제|及其|盐类|except|unless|exception|\bwith the\b|제외/i;
        if (bannedHeads.every((h) => CAT.test((ingById.get(h.id) || {}).inci_name || (ingById.get(h.id) || {}).korean_name || ""))) continue;
        // 색소 도메인(CI번호·Pigment/Solvent/Acid/Vat/Basic color)은 별도 색소 pipeline
        // (color-identity-merge·colors-positive-list·ui-color-audit)이 관리 → 비색소만 표면화(분별력).
        const COLOR = /^CI ?\d|\bpigment\b|\bsolvent (red|yellow|blue|green|orange|violet|black)|\bacid (red|yellow|blue|green|orange|violet)|\bvat \w|\bbasic (red|yellow|blue|violet|brown)|food (red|yellow|blue)|색소|顔料/i;
        const nm = (id) => (ingById.get(id) || {}).inci_name || (ingById.get(id) || {}).korean_name || "";
        if (heads.every((h) => COLOR.test(nm(h.id)))) continue;
        conflicts.push({ cc, cas,
          banned: bannedHeads.map((h) => ({ name: (ingById.get(h.id) || {}).inci_name || (ingById.get(h.id) || {}).korean_name, prio: h.prio })),
          allowed: heads.filter((h) => ALLOW.has(h.status)).map((h) => ({ name: (ingById.get(h.id) || {}).inci_name, status: h.status, prio: h.prio })),
        });
      }
    }
  }

  const report = { total: conflicts.length, note: "같은 CAS 분절 카드 간 banned↔허용 충돌(false-banned/allowed 후보). limit-overrides 로 검토 교정.", conflicts: conflicts.slice(0, 300) };
  let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(`detect-status-conflicts: 분절 status 충돌 ${conflicts.length}건 (국가별 동일CAS banned↔허용)`);
  const prevN = prev ? prev.total : null;
  if (prevN != null && conflicts.length > prevN + 5)
    console.warn(`⚠ 충돌 급증 ${prevN}→${conflicts.length} — 신규 분절/파서 regression 점검`);
}
main();
