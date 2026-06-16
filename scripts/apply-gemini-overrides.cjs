// gemini-overrides.json(Gemini 듀얼합의 자동교정·법령변경 자가치유)을 regulations/*.json 에
// prio105 행으로 baking. MFDS(100) < Gemini(105) < 내 원문대조(110) — 내 직접검증분이 항상 우선.
// 결정론·멱등(매 run 기존 Gemini 행 제거 후 재생성). 사람 개입 0. crawl/audit-cells 양쪽에서 호출 가능.
const fs = require("node:fs");
const path = require("node:path");
const DATA = path.join(__dirname, "..", "public", "data");
const REGDIR = path.join(DATA, "regulations");
const GOV = path.join(DATA, "gemini-overrides.json");
const MARK = "Gemini 자동교정";
const MINE = "Claude 원문대조 추출";

if (!fs.existsSync(GOV)) { console.log("gemini-overrides.json 없음 — skip"); process.exit(0); }
const corr = JSON.parse(fs.readFileSync(GOV, "utf8")).corrections || {};
const byCc = {};
for (const k of Object.keys(corr)) { const c = corr[k]; if (c && c.country_code) (byCc[c.country_code] ??= []).push(c); }

const now = new Date().toISOString();
let applied = 0, skippedMine = 0;
for (const f of fs.readdirSync(REGDIR).filter((x) => x.endsWith(".json"))) {
  const cc = f.replace(".json", "");
  const p = path.join(REGDIR, f);
  const obj = JSON.parse(fs.readFileSync(p, "utf8"));
  const orig = obj.rows.length;
  obj.rows = obj.rows.filter((r) => r.source_document !== MARK); // 이전 Gemini 행 제거(멱등)
  const removed = orig - obj.rows.length;
  // 내 원문 override 가 있는 셀(ingredient+cc)은 Gemini 자동교정 건너뜀(직접검증 우선).
  const mine = new Set(obj.rows.filter((r) => r.source_document === MINE).map((r) => r.ingredient_id));
  let added = 0;
  for (const c of (byCc[cc] || [])) {
    if (mine.has(c.ingredient_id)) { skippedMine++; continue; }
    obj.rows.push({
      ingredient_id: c.ingredient_id, country_code: cc, status: c.status || "restricted",
      max_concentration: c.max ?? null, concentration_unit: "%", product_categories: [],
      conditions: c.reason ? `[Gemini 자동교정] ${c.reason}` : "[Gemini 자동교정]",
      source_url: null, source_document: MARK, source_version: now.slice(0, 10), source_priority: 105,
      last_verified_at: now, confidence_score: c.confidence ?? 0.9,
      override_note: `Gemini 듀얼합의 자동교정(${c.from}→${c.status}) — 법령변경 자가치유`,
    });
    added++; applied++;
  }
  if (removed || added) fs.writeFileSync(p, JSON.stringify(obj), "utf8");
}
console.log(`apply-gemini-overrides: ${applied}건 baking(prio105), 내 원문override 우선 skip ${skippedMine}`);
