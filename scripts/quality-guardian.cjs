// 데이터 품질 자가복구 가디언 (결정론·무료) — crawl.yml 에서 매일 모든 파서 실행 후·commit 전 실행.
// 정품검증으로 발견한 "포맷취약성→무음누락" 결함 클래스를 매일 자동 교정한다(나 없어도, Gemini 없이).
// = "무료 제미나이로도 운용" 의 1차 방어선. Gemini 는 결정론으로 못 고치는 잔여만(quality-guardian-gemini, 별도).
//
// 하는 일(전부 결정론·보수적·오표기 0 지향):
//  1) 불가능한 농도값 제거: max_concentration > 100 또는 ≤ 0 (= %로 불가능) → null.
//  2) 오염된 성분명 격리(quarantine): RTL 역순 헤더쓰레기·미디코드 엔티티 → flag 집계(+ 이슈).
//     이름을 멋대로 바꾸지 않음(조작 방지). 격리 후보만 보고 → 파서/수동 복구 대상.
//  3) 회귀 감지: 국가별 행수를 직전 baseline 과 비교, 급감 시 flag.
//
// ⚠ 한도(농도) 자동 backfill 은 하지 않는다. '키워드+단일%' 휴리스틱은 쉼표 소수점("0,68%")·
//   비한도 % 를 오채택해 *틀린 숫자*를 만들 수 있음(실측됨). 한도 추출은 포맷을 아는 per-source
//   파서(extractMaxConc 등, 쉼표 정규화 포함)에서만. 가디언은 '불가능값 제거 + flag' 의 안전 역할.
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "..", "public", "data");
const REGDIR = path.join(DATA, "regulations");
const BASELINE = path.join(DATA, "guardian-baseline.json");

// 오염 성분명 시그니처: RTL 역순(공백 분리 단일문자 다수), HTML 엔티티, % 포함, 5+연속숫자, 과도한 길이.
function isCorruptName(name) {
  if (!name) return false;
  // 신뢰 가능한 오염 시그니처만(정상명 오탐 0 지향):
  //  - 미디코드 HTML 엔티티(&amp; 등) — 정상 INCI 엔 없음.
  //  - RTL 역순 헤더 쓰레기: "number/Chemical/Reference/identification" 등이 역순으로 박힘.
  //  - 단일문자 공백토큰 8+ = 역순 분해된 표 헤더(예 "reb m u n C E reb m u n S A C").
  // (%·장문·연속숫자 룰은 제거 — 정상 화학명/발효블렌드/CI번호가 그런 특징을 합법적으로 가짐.)
  if (/&#\d|&#x|&amp;|&lt;|&gt;/.test(name)) return true;
  if (/reb\s?m\s?u\s?n|laci\s?m\s?eh\s?c|recnerefe|noitacifitnedi|lanruoj/i.test(name)) return true;
  if ((name.match(/(?:^|\s)[A-Za-z](?=\s|$)/g) || []).length >= 8) return true;
  return false;
}

function loadJson(p, def) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : def; }

function main() {
  let overFixed = 0;
  const counts = {};
  for (const f of fs.readdirSync(REGDIR).filter((x) => x.endsWith(".json"))) {
    const cc = f.replace(".json", ""), p = path.join(REGDIR, f);
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    let changed = false;
    for (const r of obj.rows) {
      // 불가능 값 제거(%로 불가능). 이름의 값이 아니라 numeric 비교라 쉼표 무관.
      if (r.max_concentration != null && (r.max_concentration <= 0 || r.max_concentration > 100)) {
        r.max_concentration = null; overFixed++; changed = true;
      }
    }
    counts[cc] = obj.rows.length;
    if (changed) fs.writeFileSync(p, JSON.stringify(obj));
  }

  // 3) 오염 성분명 격리 후보 집계
  const ingObj = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8"));
  const corrupt = ingObj.rows.filter((i) => isCorruptName(i.inci_name)).map((i) => ({ id: i.id, inci: i.inci_name.slice(0, 80) }));

  // 4) 회귀(국가별 행수 급감) 감지
  const baseline = loadJson(BASELINE, { counts: {} });
  const regressions = [];
  for (const cc in baseline.counts) {
    const before = baseline.counts[cc], now = counts[cc] ?? 0;
    if (before > 50 && now < before * 0.8) regressions.push(`${cc}: ${before}→${now} (−${Math.round((1 - now / before) * 100)}%)`);
  }

  // baseline 갱신(타임스탬프 없이 — churn 최소)
  fs.writeFileSync(BASELINE, JSON.stringify({ counts }, null, 2));

  // 격리 후보 기록(Gemini/수동 복구 대상 — 표시 제외는 query 단에서 옵션)
  fs.writeFileSync(path.join(DATA, "quarantine-names.json"), JSON.stringify({ generated: "guardian", count: corrupt.length, items: corrupt }, null, 2));

  console.log("=== 품질 가디언(결정론·안전: 불가능값 제거 + 이상 flag) ===");
  console.log(`  불가능값(>100/≤0) 제거: ${overFixed}`);
  console.log(`  오염 성분명 격리 후보: ${corrupt.length}`);
  console.log(`  국가 행수 급감(회귀): ${regressions.length ? regressions.join(", ") : "없음"}`);
  if (regressions.length) { console.error("✗ 회귀 감지 — 확인 필요"); process.exitCode = 0; } // 정보성(파이프라인 중단 안 함)
}

main();
