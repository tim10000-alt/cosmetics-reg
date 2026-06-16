// limit-overrides.json (Claude 가 원문 대조로 추출한 한도/조건) 을 regulations/*.json 에
// 반영. crawl.yml 마지막(모든 소스 갱신·parse 후, commit 전)에 실행하므로, 매일 MFDS/소스
// 재생성과 무관하게 override 가 항상 유지됨(durable). additive-row 방식 + 멱등:
//   매 run 기존 override 행(source_document=MARK) 제거 후 파일 기준으로 재생성.
// → 증분: limit-overrides.json 에 추가/수정분만 쌓으면 자동 반영, 삭제도 반영.
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "..", "public", "data");
const OV = path.join(DATA, "limit-overrides.json");
const REGDIR = path.join(DATA, "regulations");
const MARK = "Claude 원문대조 추출";

if (!fs.existsSync(OV)) { console.log("limit-overrides.json 없음 — skip"); process.exit(0); }
const overrides = (JSON.parse(fs.readFileSync(OV, "utf8")).overrides) || [];

const ings = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8")).rows;
const byInci = new Map(), byCas = new Map();
for (const i of ings) {
  byInci.set((i.inci_name || "").toLowerCase(), i.id);
  if (i.cas_no) for (const c of String(i.cas_no).split(/[\s,;/]+/)) { const t = c.trim().replace(/\(.*$/, ""); if (t) byCas.set(t, i.id); }  // 쉼표/세미콜론/슬래시 분리 + 주석 strip(다중 CAS 매칭, lib 미러)
}

const now = new Date().toISOString();
const byCc = {};
let resolved = 0, unmatched = 0;
for (const o of overrides) {
  const id = o.id || (o.cas && byCas.get(String(o.cas).trim())) || (o.inci && byInci.get(o.inci.toLowerCase()));
  if (!id) { unmatched++; console.warn(`  ⚠ 미매칭 override: ${o.inci || o.cas} (${o.cc})`); continue; }
  (byCc[o.cc] ??= []).push({ ...o, id });
  resolved++;
}

let applied = 0;
for (const f of fs.readdirSync(REGDIR).filter((x) => x.endsWith(".json"))) {
  const cc = f.replace(".json", "");
  const p = path.join(REGDIR, f);
  const obj = JSON.parse(fs.readFileSync(p, "utf8"));
  const orig = obj.rows.length;
  obj.rows = obj.rows.filter((r) => r.source_document !== MARK); // 이전 override 행 제거(멱등)
  const removed = orig - obj.rows.length;
  let added = 0;
  for (const o of (byCc[cc] || [])) {
    obj.rows.push({
      ingredient_id: o.id, country_code: cc, status: o.status || "restricted",
      max_concentration: o.max ?? null, concentration_unit: o.unit || "%",
      product_categories: o.categories || [], conditions: o.note || null,
      source_url: o.src_url || null, source_document: MARK,
      // priority 110 > 자국 1차(MFDS 100): override 는 원문 직접대조 권위 교정이라 헤드라인 status·
      // 한도를 결정해야 함. (예: MFDS TiO2 행이 status=unknown 이라 헤드라인이 "분류 확인 필요"로
      // 잘못 뜨던 것 — override restricted/25% 가 우선해야 정상. 원본 MFDS 행은 "다른 출처"로 보존.)
      source_version: now.slice(0, 10), source_priority: 110,
      last_verified_at: now, confidence_score: 0.9,
      override_note: o.ref || "원문 PDF 직접 대조(Claude)",
    });
    added++; applied++;
  }
  if (removed || added) fs.writeFileSync(p, JSON.stringify(obj), "utf8");
}
console.log(`apply-overrides: ${applied}건 반영 (해석 ${resolved}, 미매칭 ${unmatched})`);
