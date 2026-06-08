// 데이터 품질 자동 점검 — 매일 산출물의 품질 지표를 계산하고 직전(quality-report.json)
// 대비 '회귀'를 감지한다. crawl.yml(커밋 전) + watchdog.yml 에서 실행.
//   · 회귀 감지 시 exit 1 + 사유 출력 → watchdog 이 GitHub Issue 자동 생성.
//   · quality-report.json 을 갱신(커밋)해 추이를 장기 추적.
// 목적: 전자동 운용에서 parser 파손·커버리지 급감·충돌 급증 등 '조용한 품질 저하'를
//       사람이 모르고 지나치지 않게.
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "..", "public", "data");
const REGDIR = path.join(DATA, "regulations");
const REPORT = path.join(DATA, "quality-report.json");

// 쿼리(regulations-query)의 1차행 선택과 동일 로직 — 지표가 '사용자가 보는 값' 반영.
const byP = (a, b) => (b.source_priority ?? 0) - (a.source_priority ?? 0);
const detailScore = (r) => {
  const c = r.conditions || "";
  const identityOnly = c.length < 20 || /등재 \(Reference \d+\)/.test(c);
  return (r.max_concentration != null ? 2 : 0) + (!identityOnly && c.length >= 60 ? 1 : 0);
};
const pick = (g) => {
  const ws = [...g].sort(byP)[0].status;
  return [...g].sort((a, b) => {
    const aw = a.status === ws ? 1 : 0, bw = b.status === ws ? 1 : 0;
    if (aw !== bw) return bw - aw;
    const d = detailScore(b) - detailScore(a);
    if (d) return d;
    return byP(a, b);
  })[0];
};
const hasLimitInfo = (r) => r.max_concentration != null || /최대\s*농도|배합\s*한도|\d+(\.\d+)?\s*%/.test(r.conditions || "");

function compute() {
  const meta = JSON.parse(fs.readFileSync(path.join(DATA, "meta.json"), "utf8"));
  const coverage = {};
  // 권위(1차 원문) 커버리지 — prio≥100 비-MFDS 직접출처를 가진 성분 수. 1차 파서 확장의 진척을
  // *관찰 가능*하게 만들고(매일 늘어야 정상), 1차 파서 파손(총 커버리지는 유지되나 권위→relayed
  // 로 후퇴)을 총 커버리지와 별개로 조기감지. KR 은 MFDS 가 자국 1차라 의도적으로 제외(오탐 방지).
  const authCoverage = {};
  const isAuth = (r) => (r.source_priority ?? 0) >= 100 && !/MFDS/.test(r.source_document || "");
  let totalRegs = 0, restrictedNoLimit = 0, statusConflicts = 0;
  for (const f of fs.readdirSync(REGDIR).filter((x) => x.endsWith(".json"))) {
    const cc = f.replace(".json", "");
    const rows = JSON.parse(fs.readFileSync(path.join(REGDIR, f), "utf8")).rows;
    totalRegs += rows.length;
    const by = new Map();
    for (const r of rows) { if (!by.has(r.ingredient_id)) by.set(r.ingredient_id, []); by.get(r.ingredient_id).push(r); }
    coverage[cc] = by.size;
    let auth = 0;
    for (const [, g] of by) {
      const p = pick(g);
      if (p.status === "restricted" && !hasLimitInfo(p)) restrictedNoLimit++;
      const ss = new Set(g.map((x) => x.status));
      if (ss.has("banned") && (ss.has("listed") || ss.has("allowed"))) statusConflicts++;
      if (cc !== "KR" && g.some(isAuth)) auth++;
    }
    authCoverage[cc] = auth;
  }
  let quarantinePending = 0;
  try { quarantinePending = JSON.parse(fs.readFileSync(path.join(DATA, "quarantine.json"), "utf8")).rows.filter((q) => q.status === "pending").length; } catch {}
  // CAS 오염 의심 큐 크기 — *증가* 가 신규 오염/파서버그(cross-link 양산) 신호(절대값은 대부분 legit).
  let casContaminationSuspects = 0;
  try { casContaminationSuspects = JSON.parse(fs.readFileSync(path.join(DATA, "cas-contamination-suspects.json"), "utf8")).count ?? 0; } catch {}
  // 가디언 신선도/이상 리포트 — stale 은 latest 로 days 재계산(>임계).
  let staleCount = 0, staleSources = [], limitAnomalyCount = 0, postHealCorrupt = 0, postHealWhitespace = 0;
  try {
    const h = JSON.parse(fs.readFileSync(path.join(DATA, "source-health.json"), "utf8"));
    const thr = h.stale_threshold_days ?? 45, now = new Date();
    for (const s of h.regulations_by_country || []) {
      if (s.latest && (now - new Date(s.latest)) / 86400000 > thr) { staleCount++; staleSources.push(s.cc); }
    }
    for (const d of h.ingredient_dictionaries || []) {  // 성분사전(법령과 별개 출처)도 감시
      if (d.latest && (now - new Date(d.latest)) / 86400000 > thr) { staleCount++; staleSources.push(d.name); }
    }
    limitAnomalyCount = h.limit_anomaly_count ?? 0;
    postHealCorrupt = h.post_heal_corrupt_count ?? 0;
    postHealWhitespace = h.post_heal_whitespace_count ?? 0;
  } catch {}
  return { generated_at: meta.generated_at, totalRegs, coverage, authCoverage, restrictedNoLimit, statusConflicts, quarantinePending, casContaminationSuspects, staleCount, staleSources, limitAnomalyCount, postHealCorrupt, postHealWhitespace };
}

function detectRegressions(cur, prev) {
  if (!prev) return [];
  const out = [];
  if (cur.totalRegs < prev.totalRegs * 0.9) out.push(`총 규제 급감: ${prev.totalRegs}→${cur.totalRegs} (-10%↑)`);
  for (const cc of Object.keys(prev.coverage || {})) {
    const a = prev.coverage[cc] ?? 0, b = cur.coverage[cc] ?? 0;
    if (a > 50 && b < a * 0.9) out.push(`${cc} 커버리지 급감: ${a}→${b} (-10%↑) — parser 파손 의심`);
  }
  // 권위(1차) 커버리지 급감 — 총 커버리지는 유지돼도 권위 출처가 빠지면(1차 파서 파손·양식변경)
  // 조기경보. 확장은 점진적(증가)이라 *감소*만 회귀로 본다.
  for (const cc of Object.keys(prev.authCoverage || {})) {
    const a = prev.authCoverage[cc] ?? 0, b = (cur.authCoverage || {})[cc] ?? 0;
    if (a > 50 && b < a * 0.9) out.push(`${cc} 권위(1차) 커버리지 급감: ${a}→${b} (-10%↑) — 1차 파서 파손/양식변경 의심`);
  }
  // CAS 오염 의심 큐 급증 — 신규 오염 or 파서버그(cross-link 양산). 절대값은 대부분 legit 이라
  // *증가*만(>20% AND +30↑) 경보. 평상시 신규 성분의 대체명 추가(+1~2)는 무시.
  // prev 에 필드가 없으면(최초 측정=baseline 확립) skip — 0→N 거짓경보 방지.
  if (prev.casContaminationSuspects != null) { const a = prev.casContaminationSuspects, b = cur.casContaminationSuspects ?? 0;
    if (b > a * 1.2 && b - a >= 30) out.push(`CAS 오염 의심 급증: ${a}→${b} — 파서 cross-link 양산/신규 오염 점검(cas-contamination-suspects.json)`); }
  if (cur.restrictedNoLimit > (prev.restrictedNoLimit ?? 0) * 1.1 + 50) out.push(`한도누락 restricted 증가: ${prev.restrictedNoLimit}→${cur.restrictedNoLimit}`);
  if (cur.statusConflicts > (prev.statusConflicts ?? 0) * 1.2 + 20) out.push(`status 충돌 증가: ${prev.statusConflicts}→${cur.statusConflicts}`);
  // 가디언 신선도/이상 — 신규 발생 시만 경보(스팸 방지). stale=소스 동결/fetch차단, anomaly=한도 급변.
  if (cur.staleCount > (prev.staleCount ?? 0)) out.push(`국가 cascade 동결 증가(>45일 전층 미갱신): ${prev.staleCount ?? 0}→${cur.staleCount} [${(cur.staleSources || []).join(", ")}] — 1·2·3차 모두 차단/실패 확인`);
  if (cur.limitAnomalyCount > 0) out.push(`한도 5배+ 급변 ${cur.limitAnomalyCount}건 — silent 오파싱 의심, source-health.json 의 limit_anomalies 확인`);
  // 절대 경보(직전 대비 아님): 가디언 self-heal 후에도 가시 오염/공백이 남으면 = 가디언이 못 잡는
  // 새 오염 패턴 유입 → 즉시 알림(재발방지 안전망의 '감지' 축). 정상은 항상 0.
  if (cur.postHealCorrupt > 0) out.push(`🩺 self-heal 후 잔존 오염명 ${cur.postHealCorrupt}건 — 가디언 미인식 새 오염 패턴, isCorruptName/recover 로직 보강 필요`);
  if (cur.postHealWhitespace > 0) out.push(`🩺 self-heal 후 잔존 이름공백 ${cur.postHealWhitespace}건 — 가디언 trim 누락 경로 확인`);
  return out;
}

const cur = compute();
const prev = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, "utf8")) : null;
const regressions = detectRegressions(cur, prev);
fs.writeFileSync(REPORT, JSON.stringify({ ...cur, checked_at_note: "matches regulations-query primary-row logic" }, null, 2));

console.log("=== 데이터 품질 지표 ===");
console.log(`  총 규제: ${cur.totalRegs} | restricted 한도누락: ${cur.restrictedNoLimit} | status충돌: ${cur.statusConflicts} | quarantine: ${cur.quarantinePending}`);
console.log(`  커버리지(성분수): ${Object.entries(cur.coverage).map(([k, v]) => k + ":" + v).join(" ")}`);
  console.log(`  권위(1차) 커버리지: ${Object.entries(cur.authCoverage || {}).map(([k, v]) => k + ":" + v).join(" ")}`);
  console.log(`  CAS 오염 의심 큐(대부분 legit, *증가*가 신호): ${cur.casContaminationSuspects}`);
if (regressions.length) {
  console.error("\n🔴 품질 회귀 감지:");
  for (const r of regressions) console.error("  - " + r);
  process.exit(1);
}
console.log(prev ? "\n✓ 직전 대비 회귀 없음" : "\n✓ baseline 최초 기록");
