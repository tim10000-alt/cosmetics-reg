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
  // 단일토큰(영문자/숫자/점) 8개+ = 표 헤더/citation 이 공백분해돼 박힌 것(RTL 역순 or 정방향).
  // 숫자도 포함해야 "N E 9 0 0 2 . 2 1" 같은 날짜/EC번호 분해 꼬리를 잡음. 정상명엔 이만큼 없음.
  if ((name.match(/(?:^|\s)[A-Za-z0-9.](?=\s|$)/g) || []).length >= 8) return true;
  // JP 別表1 matrix-bleed: 일본어명 + ○ 또는 연접 소수점(셀 공백 손실로 "システイン421.51.5…").
  if (/[ぁ-んァ-ヶ]/.test(name) && (/○/.test(name) || /\d\.\d\d?\.\d/.test(name) || /\d{3,}\./.test(name))) return true;
  return false;
}

// JP 別表1 matrix-bleed 실명 회복: 일본어명 뒤 "코드(1/31/41/42/72/73)+소수점값" 또는 ○ 또는
// 연접 소수점이 시작되는 지점에서 절단. 각주문("…。") 포함분은 회복 거부(격리).
function recoverJpMatrix(name) {
  const m = name.match(/^(.*?[ぁ-んァ-ヶ一-龯])(?:(?:1|31|41|42|72|73)\d*\.\d|○|\d+\.\d{2,})/);
  if (!m) return null;
  const head = m[1].trim();
  if (head.length < 2 || /[。○]/.test(head) || /\d\.\d\d?\.\d/.test(head)) return null; // 각주/잔존 matrix → 거부
  return head;
}

// RTL 역순 헤더 꼬리 제거: 단일문자(영숫자/./슬래시) 토큰이 4개+ 연속되기 시작하는 지점에서 절단.
// "Cantharidine N E 4 8 / 2 4 3 ..." → "Cantharidine". 정상명의 "L."·"No."(2자+)는 단일문자 아님→보존.
function stripRtlTail(name) {
  const toks = String(name).split(/\s+/);
  const isSingle = (t) => /^[A-Za-z0-9/.]$/.test(t);
  for (let i = 0; i <= toks.length - 4; i++) {
    if (isSingle(toks[i]) && isSingle(toks[i + 1]) && isSingle(toks[i + 2]) && isSingle(toks[i + 3])) {
      return toks.slice(0, i).join(" ").replace(/[\s/]+$/, "").trim();
    }
  }
  return name; // RTL 꼬리 패턴 없음(다른 오염) → 그대로(격리)
}

function loadJson(p, def) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : def; }

function main() {
  let overFixed = 0;
  const counts = {};
  const srcLatest = {};      // source_document → 최신 last_verified_at (신선도 감시)
  const limitNow = {};       // ingredient_id|cc → max_concentration (한도 급변 이상탐지)
  for (const f of fs.readdirSync(REGDIR).filter((x) => x.endsWith(".json"))) {
    const cc = f.replace(".json", ""), p = path.join(REGDIR, f);
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    let changed = false;
    for (const r of obj.rows) {
      // 불가능 값 제거(%로 불가능). 이름의 값이 아니라 numeric 비교라 쉼표 무관.
      if (r.max_concentration != null && (r.max_concentration <= 0 || r.max_concentration > 100)) {
        r.max_concentration = null; overFixed++; changed = true;
      }
      const src = (r.source_document || "?").replace(/\s*\(.*$/, "").slice(0, 40);
      if ((r.last_verified_at || "") > (srcLatest[src] || "")) srcLatest[src] = r.last_verified_at || "";
      if (r.max_concentration != null) limitNow[`${r.ingredient_id}|${cc}`] = r.max_concentration;
    }
    counts[cc] = obj.rows.length;
    if (changed) fs.writeFileSync(p, JSON.stringify(obj));
  }

  // 3) 오염 성분명: RTL 역순 헤더 bleed("Cantharidine N E 4 8 … reb m u n …")는 실명+꼬리쓰레기 →
  //    단일문자 토큰 4+ 연속 시작점에서 잘라 실명 회복(결정론·보수적). 회복 실패분만 격리 flag.
  const ingObj = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8"));
  let recovered = 0, ingChanged = false;
  const corrupt = [];
  for (const i of ingObj.rows) {
    if (!isCorruptName(i.inci_name)) continue;
    const cleaned = stripRtlTail(i.inci_name);            // RTL 역순 헤더 꼬리
    const jp = recoverJpMatrix(i.inci_name);              // JP matrix-bleed
    const best = (cleaned && cleaned !== i.inci_name) ? cleaned : jp;
    if (best && best.length >= 2 && !isCorruptName(best)) {
      i.inci_name = best; recovered++; ingChanged = true; // 실명 회복
    } else {
      corrupt.push({ id: i.id, inci: i.inci_name.slice(0, 80) }); // 회복 불가 → 격리
    }
  }
  if (ingChanged) fs.writeFileSync(path.join(DATA, "ingredients.json"), JSON.stringify(ingObj));

  // 4) 회귀(국가별 행수 급감) 감지
  const baseline = loadJson(BASELINE, { counts: {} });
  const regressions = [];
  for (const cc in baseline.counts) {
    const before = baseline.counts[cc], now = counts[cc] ?? 0;
    if (before > 50 && now < before * 0.8) regressions.push(`${cc}: ${before}→${now} (−${Math.round((1 - now / before) * 100)}%)`);
  }

  // 5) 소스 신선도 감시 — 소스가 N일 넘게 갱신 안 되면 stale(=fetch 차단/동결/upstream 새 URL).
  //    API 소스(MFDS/NMPA)는 매일 갱신되므로 정상이면 안 걸림. 고정파일/zip 의존 소스(ASEAN·BR·AR
  //    등)가 동결되면 여기서 드러남 → silent rot 방지. (전 국가 신규법규 자동발견은 원천 불가 —
  //    이 감시가 현실적 안전장치.)
  const STALE_DAYS = 45;
  const today = new Date();
  const health = Object.entries(srcLatest).map(([src, d]) => {
    const days = d ? Math.round((today - new Date(d)) / 86400000) : 9999;
    return { src, latest: (d || "").slice(0, 10), days, stale: days > STALE_DAYS };
  }).sort((a, b) => b.days - a.days);
  const stale = health.filter((h) => h.stale);

  // 6) 한도 급변 이상탐지 — 직전 스냅샷 대비 5배+ 변동(0.5→5 같은 silent 오파싱 클래스 포착).
  const SNAP = path.join(DATA, "limit-snapshot.json");
  const prev = loadJson(SNAP, {});
  const limitAnomalies = [];
  for (const k in limitNow) {
    const a = prev[k], b = limitNow[k];
    if (a != null && b != null && a > 0.01 && b > 0.01 && (b / a >= 5 || a / b >= 5)) {
      limitAnomalies.push(`${k}: ${a}→${b}`);
    }
  }
  fs.writeFileSync(SNAP, JSON.stringify(limitNow));

  fs.writeFileSync(BASELINE, JSON.stringify({ counts }, null, 2));
  fs.writeFileSync(path.join(DATA, "quarantine-names.json"), JSON.stringify({ generated: "guardian", count: corrupt.length, items: corrupt }, null, 2));
  // latest 만 저장(days 는 휘발성이라 churn 유발 → 제외, 읽을 때 계산). stale_count/anomaly 는
  // 임계 교차/이상 발생 시에만 변해 저churn → data-quality-check 가 신규증가 시 이슈 트리거.
  fs.writeFileSync(path.join(DATA, "source-health.json"), JSON.stringify(
    { stale_threshold_days: STALE_DAYS, stale_count: stale.length, stale_sources: stale.map((s) => s.src),
      limit_anomaly_count: limitAnomalies.length, limit_anomalies: limitAnomalies.slice(0, 20),
      sources: health.map((h) => ({ src: h.src, latest: h.latest })) }, null, 2));

  console.log("=== 품질 가디언(자가복구 + 신선도/이상 감시) ===");
  console.log(`  불가능값(>100/≤0) 제거: ${overFixed}`);
  console.log(`  오염명 실명 복구(RTL 헤더 + JP matrix): ${recovered}`);
  console.log(`  격리(복구 불가) 성분명: ${corrupt.length}`);
  console.log(`  국가 행수 급감(회귀): ${regressions.length ? regressions.join(", ") : "없음"}`);
  console.log(`  ⏳ stale 소스(>${STALE_DAYS}일 미갱신): ${stale.length ? stale.map((s) => `${s.src.slice(0, 22)}(${s.days}d)`).join(", ") : "없음"}`);
  console.log(`  📊 한도 급변(5배+) 이상: ${limitAnomalies.length ? limitAnomalies.slice(0, 8).join(", ") : "없음"}`);
  if (regressions.length || stale.length || limitAnomalies.length) {
    console.error(`✗ 주의: 회귀 ${regressions.length}·stale ${stale.length}·한도이상 ${limitAnomalies.length} — source-health.json 확인`);
  }
}

main();
