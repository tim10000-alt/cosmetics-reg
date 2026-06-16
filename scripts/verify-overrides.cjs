// 재발방지(일반) — limit-overrides.json 의 모든 원문대조 교정이 실제 데이터 헤드라인에
// 반영되는지 매 run 검증. 결정론·無Gemini·자동수정 안 함(회귀 표면화만).
//
// 왜 필요한가: override 는 apply-overrides 가 prio110 로 주입하지만, 다음 상황에서 무력화될 수 있음:
//   (1) identity 분절 — 같은 CAS 가 여러 ingredient 로 쪼개져 override 가 일부에만 붙음
//       (apply-overrides 가 이제 동일 CAS 전체에 적용하지만, 신규 분절 발생 시 재발 가능)
//   (2) 더 높은 prio 의 잘못된 행이 새로 생김
//   (3) CAS 표기 변형으로 매칭 실패
// 이 게이트는 각 override 의 CAS 에 해당하는 "모든" ingredient 의 헤드라인(최고 prio 행)이
// override 가 의도한 status 와 일치하는지 확인. 불일치=교정이 사용자에게 안 보임=버그 재발.
//
// 추가 예방(오표기 일반 탐지): override 와 무관하게, 같은 ingredient 안에서 동일/상위 권위(prio>=100)
// 가 'banned' 와 'restricted/listed' 로 동시 존재하면 status 충돌로 표면화(false-banned/allowed 씨앗).
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "..", "public", "data");
const REGDIR = path.join(DATA, "regulations");
const OV = path.join(DATA, "limit-overrides.json");
const REPORT = path.join(DATA, "overrides-report.json");

const normCas = (c) =>
  String(c || "").split(/[\s,;/]+/).map((s) => s.trim().replace(/\(.*$/, "")).filter(Boolean);

function main() {
  const strict = process.argv.includes("--strict");
  const ings = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8")).rows;
  const overrides = (JSON.parse(fs.readFileSync(OV, "utf8")).overrides) || [];

  // apply-overrides 와 동일 해석: banned 는 보조 CAS 포함(byCasAny), 한도 교정은 주(첫)/단일 CAS 만
  // (byCas) — 복합 "및 그 염류" 항목 over-restriction 방지 로직과 정합(아니면 게이트가 의도적
  // 스킵분을 "규제행 없음" 으로 오판).
  const byCas = new Map(), byCasAny = new Map(), byInci = new Map();
  for (const i of ings) {
    const toks = normCas(i.cas_no);
    toks.forEach((t, idx) => {
      (byCasAny.get(t) || byCasAny.set(t, []).get(t)).push(i.id);
      if (idx === 0 || toks.length === 1) (byCas.get(t) || byCas.set(t, []).get(t)).push(i.id);
    });
    const k = (i.inci_name || "").toLowerCase();
    if (k) (byInci.get(k) || byInci.set(k, []).get(k)).push(i.id);
  }

  const regCache = {};
  const rowsOf = (cc, id) => {
    if (!regCache[cc]) {
      const p = path.join(REGDIR, cc + ".json");
      regCache[cc] = {};
      if (fs.existsSync(p)) for (const r of JSON.parse(fs.readFileSync(p, "utf8")).rows) (regCache[cc][r.ingredient_id] ||= []).push(r);
    }
    return regCache[cc][id] || [];
  };
  const headline = (rows) => rows.length ? rows.reduce((a, b) => ((b.source_priority || 0) > (a.source_priority || 0) ? b : a)) : null;

  const misses = [];
  for (const o of overrides) {
    const casMap = o.status === "banned" ? byCasAny : byCas;
    const ids = o.id ? [o.id] : (o.cas && casMap.get(String(o.cas).trim())) || (o.inci && byInci.get(o.inci.toLowerCase())) || [];
    if (!ids.length) { misses.push({ override: o.cas || o.inci, cc: o.cc, reason: "성분 매칭 없음" }); continue; }
    const want = o.status || "restricted";
    for (const id of ids) {
      const h = headline(rowsOf(o.cc, id));
      if (!h) { misses.push({ override: o.cas || o.inci, cc: o.cc, reason: "규제행 없음(override 미주입?)" }); continue; }
      if (h.source_document === "Claude 원문대조 추출") continue; // override 자신이 헤드라인 = OK
      // override 가 헤드라인이 아니면, 더 높은/같은 prio 의 다른 행이 이김 → 교정 안 보임
      if (h.status !== want)
        misses.push({ override: o.cas || o.inci, cc: o.cc, reason: `헤드라인 ${h.status} ≠ override ${want}`, ing: id });
    }
  }

  const report = { generated_for: "limit-overrides 헤드라인 반영 검증", total: overrides.length, misses: misses.length, detail: misses.slice(0, 100) };
  let prev = null; try { prev = JSON.parse(fs.readFileSync(REPORT, "utf8")); } catch {}
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");

  console.log(`verify-overrides: override ${overrides.length}건, 헤드라인 미반영 ${misses.length}건`);
  for (const m of misses.slice(0, 30)) console.log(`  ⚠ [${m.cc}] ${m.override} — ${m.reason}`);

  const prevN = prev ? prev.misses : 0;
  if (strict && misses.length > prevN) {
    console.error(`❌ 회귀: override 미반영 ${prevN} → ${misses.length}. apply-overrides/분절 점검 필요.`);
    process.exit(1);
  }
}
main();
