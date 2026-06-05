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

// ── CAS 정규화 ─────────────────────────────────────────────────────────────
// cas_no 는 IngredientHeader 에 그대로 노출된다(화학 도구에서 핵심 표시값). 시드/엑셀
// 경유 데이터에 (a) 날짜화("7/2/81", "4630/07/03") (b) 체크디짓 절단("7782-85")
// (c) 비ASCII 하이픈("6614‑96‑6") 등 깨진 값이 섞여 UI 에 그대로 떴다.
// 원칙: **유효 CAS(체크디짓 검증)가 하나라도 있으면 절대 건드리지 않는다**(오삭제 0).
// 유효값이 전혀 없을 때만 — 체크디짓이 맞는 복구만 적용, 복구 불가한 순수 아티팩트
// (날짜 m/d/yy·"0"·"-")만 null. 이름/EC번호/그룹텍스트는 보존(우리가 판단할 일 아님).
// 원소명 ↔ 원소 CAS 레퍼런스(물리 상수). inci_name 이 정확히 원소명인데 CAS 가 *다른 원소*의
// CAS 면 명백한 오기 → 정정. (실측 사례: Gold 가 백금 CAS, Copper 가 은 CAS → 금↔백금·구리↔은
// 오병합 유발.) 매 run 자가치유 = 봇 갱신이 또 틀린 CAS 를 가져와도 durable·무료 자동.
const ELEMENT_CAS = { gold: "7440-57-5", silver: "7440-22-4", copper: "7440-50-8", platinum: "7440-06-4", lead: "7439-92-1", zinc: "7440-66-6", iron: "7439-89-6", aluminum: "7429-90-5", aluminium: "7429-90-5", titanium: "7440-32-6", tin: "7440-31-5", nickel: "7440-02-0", chromium: "7440-47-3", bismuth: "7440-69-9", palladium: "7440-05-3", magnesium: "7439-95-4", manganese: "7439-96-5", barium: "7440-39-3", cobalt: "7440-48-4" };
const ELEMENT_BY_CAS = Object.fromEntries(Object.entries(ELEMENT_CAS).map(([e, c]) => [c, e]));
const CAS_RE = /^\d{2,7}-\d{2}-\d$/;
function casCheckDigit(twoGroups) {            // "7782-85" → 6
  const d = twoGroups.replace(/-/g, "").split("").map(Number);
  let s = 0; for (let i = 0; i < d.length; i++) s += d[d.length - 1 - i] * (i + 1);
  return s % 10;
}
function casValid(c) {                          // 형식 + 체크디짓 동시 검증
  if (!CAS_RE.test(c)) return false;
  const p = c.split("-");
  return casCheckDigit(p[0] + "-" + p[1]) === Number(p[2]);
}
function recoverCasToken(tok) {                 // 단일 토큰 → 유효 CAS 또는 null
  let t = String(tok).replace(/[‑–—]/g, "-").replace(/[\r\t]/g, "").replace(/\?+$/, "").trim();
  const core = t.replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, "").trim();  // [1] 각주·qualifier 제거
  if (casValid(core)) return core;
  let m = core.match(/^(\d{2,7})\/(\d{1,2})\/(\d{1,3})$/);                      // 슬래시 날짜화 → 대시
  if (m) { for (const mid of new Set([m[2], m[2].padStart(2, "0")])) { const c = m[1] + "-" + mid + "-" + String(Number(m[3])); if (casValid(c)) return c; } }
  m = core.match(/^(\d{2,7}-\d{2})-?$/);                                        // 체크디짓 절단 → 계산
  if (m) { const c = m[1] + "-" + casCheckDigit(m[1]); if (casValid(c)) return c; }
  return null;
}
function normalizeCas(raw) {                     // {value, action: none|recovered|nulled}
  if (raw == null) return { value: raw, action: "none" };
  const txt = String(raw).replace(/[‑–—]/g, "-");
  const present = (txt.match(/\d{2,7}-\d{2}-\d/g) || []).filter(casValid);
  if (present.length) return { value: raw, action: "none" };                    // 유효 CAS 보유 → 무수정
  const rec = [...new Set(txt.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).map(recoverCasToken).filter(Boolean))];
  if (rec.length) return { value: rec.join(", "), action: "recovered" };
  const v = txt.trim();
  const artifact = /^[-—–]$/.test(v) || /^0+$/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v) || /^\d{1,2}-\d{1,2}-\d{1,2}$/.test(v);
  return artifact ? { value: null, action: "nulled" } : { value: raw, action: "none" };
}

function loadJson(p, def) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : def; }

function main() {
  let overFixed = 0;
  const counts = {};
  const srcLatest = {};      // source_document → 최신 last_verified_at (진단용)
  const ccLatest = {};       // country → 최신 last_verified_at (신선도 감시 = cascade-aware)
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
      const lv = r.last_verified_at || "";
      if (lv > (srcLatest[src] || "")) srcLatest[src] = lv;
      if (lv > (ccLatest[cc] || "")) ccLatest[cc] = lv; // 국가별 최신(cascade 중 가장 신선한 층)
      if (r.max_concentration != null) limitNow[`${r.ingredient_id}|${cc}`] = r.max_concentration;
    }
    counts[cc] = obj.rows.length;
    if (changed) fs.writeFileSync(p, JSON.stringify(obj));
  }

  // 3) 오염 성분명: RTL 역순 헤더 bleed("Cantharidine N E 4 8 … reb m u n …")는 실명+꼬리쓰레기 →
  //    단일문자 토큰 4+ 연속 시작점에서 잘라 실명 회복(결정론·보수적). 회복 실패분만 격리 flag.
  const ingObj = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8"));
  let recovered = 0, ingChanged = false;
  let nameFieldRecovered = 0, nameFieldNulled = 0;       // 보조 표시명(한/중/일) 정리
  let casRecovered = 0, casNulled = 0, casElementFixed = 0;   // CAS 정규화 + 원소CAS 오기교정
  const corrupt = [];
  // 한 필드의 오염명 복구 시도 — RTL 꼬리 절단 또는 JP matrix-bleed 절단. 회복 결과가 깨끗하면 반환.
  const recoverName = (v) => {
    const cleaned = stripRtlTail(v);                      // RTL 역순 헤더 꼬리
    const jp = recoverJpMatrix(v);                        // JP matrix-bleed
    const best = (cleaned && cleaned !== v) ? cleaned : jp;
    return (best && best.length >= 2 && !isCorruptName(best)) ? best : null;
  };
  for (const i of ingObj.rows) {
    // inci_name = 검색 키/제목 — 복구 실패 시 레코드 전체 격리(검색에서 제외).
    if (isCorruptName(i.inci_name)) {
      const best = recoverName(i.inci_name);
      if (best) { i.inci_name = best; recovered++; ingChanged = true; } // 실명 회복
      else corrupt.push({ id: i.id, inci: i.inci_name.slice(0, 80) });  // 회복 불가 → 격리
    }
    // 보조 표시명(한/중/일) — IngredientHeader 에 그대로 노출되므로 동일 복구 필요. inci_name 이
    // 이미 복구된(=깨끗한) 레코드는 위 분기를 건너뛰어 보조 필드의 matrix-bleed 잔재가 영구히
    // 안 잡히던 버그(JP 別表1: inci 복구 후 japanese_name 에 "アラントイン410.5…" 잔존, UI 노출).
    // 복구 불가 garbage 는 레코드 격리가 아니라 *그 필드만 null* — 제목/규제는 유효하기 때문.
    // 정상명(숫자·○ 없는)은 isCorruptName=false 라 무손상(오탐 0).
    for (const f of ["korean_name", "chinese_name", "japanese_name"]) {
      if (!isCorruptName(i[f])) continue;
      const best = recoverName(i[f]);
      if (best) { i[f] = best; nameFieldRecovered++; }
      else { i[f] = null; nameFieldNulled++; }
      ingChanged = true;
    }
    // 원소명↔CAS 오기 자가치유: inci 가 정확히 원소명인데 CAS 가 다른 원소면 정정(금↔백금·구리↔은 오병합 방지).
    {
      const nm = (i.inci_name || "").toLowerCase().trim();
      const correct = ELEMENT_CAS[nm];
      if (correct) {
        const toks = String(i.cas_no || "").match(/\d{2,7}-\d{2}-\d/g) || [];
        const wrongEl = toks.some((c) => ELEMENT_BY_CAS[c] && ELEMENT_BY_CAS[c] !== nm);
        if (!toks.includes(correct) && wrongEl) { i.cas_no = correct; casElementFixed++; ingChanged = true; }
      }
    }
    // CAS 정규화 — 유효 CAS 보유 레코드는 무수정(오삭제 0), 깨진 것만 복구/null.
    if (i.cas_no != null) {
      const c = normalizeCas(i.cas_no);
      if (c.action === "recovered") { i.cas_no = c.value; casRecovered++; ingChanged = true; }
      else if (c.action === "nulled") { i.cas_no = c.value; casNulled++; ingChanged = true; }
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
  // 신선도는 *국가별*(cascade-aware)로 판정 — 한 국가는 1차(국가사이트)/2차(KCIA)/3차(MFDS) 중
  // 가장 신선한 층 기준. 1차 소스 문서가 안 바뀌어도(예 ASEAN 2019 PDF) 3차 MFDS 가 매일 갱신하면
  // 그 국가는 신선. 따라서 source 별이 아니라 country 별 최신으로 stale 판정(false 경보 방지).
  const STALE_DAYS = 45;
  const today = new Date();
  const health = Object.entries(ccLatest).map(([cc, d]) => {
    const days = d ? Math.round((today - new Date(d)) / 86400000) : 9999;
    return { cc, latest: (d || "").slice(0, 10), days, stale: days > STALE_DAYS };
  }).sort((a, b) => b.days - a.days);
  const stale = health.filter((h) => h.stale); // 국가 전체 cascade 가 동결된 경우만(진짜 문제)

  // 5-b) 성분 데이터 출처 신선도 — *법령과 별개 출처*. 둘 다 대한화장품협회(KCIA)지만 목적이 다름:
  //   · KCIA 해외법령 게시판 → 2차 *법령* 출처(위 국가별 cascade 의 2차).
  //   · KCIA 성분사전(표준화명칭목록) → *성분명* 표준화 출처(규제 아님). 여기서 별도 감시.
  //   MFDS API(성분 마스터)도 매일 갱신하지만 성분사전(WAF 다운로드)이 막히면 여기서 드러남.
  const dicts = [];
  try {
    const fp = JSON.parse(fs.readFileSync(path.join(DATA, "kcia-names-fingerprint.json"), "utf8"));
    const days = fp.parsed_at ? Math.round((today - new Date(fp.parsed_at)) / 86400000) : 9999;
    dicts.push({ name: "KCIA 성분사전(표준화명칭)", latest: (fp.parsed_at || "").slice(0, 10), stale: days > STALE_DAYS });
  } catch { /* fingerprint 없음 — skip */ }
  const dictStale = dicts.filter((d) => d.stale);

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
    { note: "법령(국가별 cascade-aware: 1차 국가사이트→2차 KCIA 해외법령→3차 MFDS)과 성분사전(KCIA 성분명 표준화)은 별개. stale=해당 출처 전체 동결.",
      stale_threshold_days: STALE_DAYS,
      stale_count: stale.length + dictStale.length, stale_countries: stale.map((s) => s.cc), stale_dictionaries: dictStale.map((d) => d.name),
      limit_anomaly_count: limitAnomalies.length, limit_anomalies: limitAnomalies.slice(0, 20),
      regulations_by_country: health.map((h) => ({ cc: h.cc, latest: h.latest })),
      ingredient_dictionaries: dicts.map((d) => ({ name: d.name, latest: d.latest })) }, null, 2));

  console.log("=== 품질 가디언(자가복구 + 신선도/이상 감시) ===");
  console.log(`  불가능값(>100/≤0) 제거: ${overFixed}`);
  console.log(`  오염명 실명 복구(RTL 헤더 + JP matrix): ${recovered}`);
  console.log(`  보조 표시명(한/중/일) 정리: 복구 ${nameFieldRecovered} · null처리 ${nameFieldNulled}`);
  console.log(`  CAS 정규화: 복구 ${casRecovered} · 깨진값(날짜/0/대시) null ${casNulled} · 원소CAS 오기교정 ${casElementFixed}`);
  console.log(`  격리(복구 불가) 성분명: ${corrupt.length}`);
  console.log(`  국가 행수 급감(회귀): ${regressions.length ? regressions.join(", ") : "없음"}`);
  console.log(`  ⏳ stale 국가법령(cascade 전체 >${STALE_DAYS}일): ${stale.length ? stale.map((s) => `${s.cc}(${s.days}d)`).join(", ") : "없음"} | stale 성분사전: ${dictStale.length ? dictStale.map((d) => d.name).join(", ") : "없음"}`);
  console.log(`  📊 한도 급변(5배+) 이상: ${limitAnomalies.length ? limitAnomalies.slice(0, 8).join(", ") : "없음"}`);
  if (regressions.length || stale.length || limitAnomalies.length) {
    console.error(`✗ 주의: 회귀 ${regressions.length}·stale ${stale.length}·한도이상 ${limitAnomalies.length} — source-health.json 확인`);
  }
}

main();
