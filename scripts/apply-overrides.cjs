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
// CAS·INCI → id "목록"(분절 동일물질 다중 entry 커버). 단, override CAS 가 그 ingredient 의
// "주(첫) CAS 이거나 단일 CAS" 인 경우에만 매칭(byCas) — 분절 변종(예 "Zinc Pyrithione"
// 대문자 MFDS행 vs "Zinc pyrithione" 소문자, 각각 단일 CAS)은 잡되, 보조 CAS 로만 끼어있는
// 복합항목(예 "o-페닐페놀 및 그 염류"[90-43-7, 132-27-4...] — 주성분 o-phenylphenol 0.30 인데
// 소듐염 132-27-4 override 0.15 가 잘못 씌워지던 over-restriction)을 배제(분별력).
// 보조 CAS 까지 넓게 매칭하는 byCasAny 는 status=banned(그룹 전체 금지=안전)에만 사용.
const byInci = new Map(), byCas = new Map(), byCasAny = new Map();
const push = (m, k, id) => { if (!k) return; const a = m.get(k) || m.set(k, []).get(k); if (!a.includes(id)) a.push(id); };
for (const i of ings) {
  push(byInci, (i.inci_name || "").toLowerCase(), i.id);
  const toks = String(i.cas_no || "").split(/[\s,;/]+/).map((c) => c.trim().replace(/\(.*$/, "")).filter(Boolean);
  toks.forEach((t, idx) => {
    push(byCasAny, t, i.id);                       // 보조 포함 전체(banned 그룹용)
    if (idx === 0 || toks.length === 1) push(byCas, t, i.id);  // 주(첫)/단일 CAS 만(한도 교정용)
  });
}

const now = new Date().toISOString();
const byCc = {};
let resolved = 0, unmatched = 0;
for (const o of overrides) {
  // banned 는 그룹 전체 금지가 안전 → 보조 CAS 포함(byCasAny). 한도 교정(restricted 등)은 주 CAS 만
  // (byCas) — 복합 "및 그 염류" 항목에 좁은 염 한도가 오적용되는 over-restriction 방지(분별력).
  const casMap = o.status === "banned" ? byCasAny : byCas;
  const ids = o.id ? [o.id] : (o.cas && casMap.get(String(o.cas).trim())) || (o.inci && byInci.get(o.inci.toLowerCase())) || [];
  if (!ids.length) { unmatched++; console.warn(`  ⚠ 미매칭 override: ${o.inci || o.cas} (${o.cc})`); continue; }
  for (const id of ids) (byCc[o.cc] ??= []).push({ ...o, id });  // 분절 동일물질에 적용
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
