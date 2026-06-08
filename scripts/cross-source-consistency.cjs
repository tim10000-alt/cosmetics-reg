#!/usr/bin/env node
// 교차출처 일관성 감사 — "데이터==실제 법령"(④축)의 자동검출 가능 부분.
// EU 를 *법적으로 채택*한 그룹(ASEAN 6·Andean 4)·Mercosur(BR/AR)는 같은 물질에 같은 권위 status 여야
// 한다. 어긋나면 = (a) 파싱/데이터 오류 후보 또는 (b) 정당한 관할권 차이(EU 가 더 엄격·버전 lag).
// 렌더와 무관한 *독립 오라클*(순환 아님). 자동 교정 금지(관할권 차이는 실제 법 — 분별력); 후보만 표면화.
// 산출: cross-source-divergences.json(검토 리스트). 미래 파서 regression(신규 desync) 조기경보용.
const fs = require("fs");
const path = require("path");
const G = require(path.join(__dirname, "verify-groundtruth.cjs"));
const { ingredients, bucketFor, siblingIds, byId } = G;
const DATA = path.join(__dirname, "..", "public", "data");
const apply = process.argv[2] === "--write";

const GROUPS = { ASEAN: ["VN", "TH", "ID", "MY", "PH", "SG"], ANDEAN: ["CO", "EC", "PE", "BO"] };
// 권위(prio≥100 비-MFDS) 대표 status
const authStatus = (ids, cc) => {
  const b = bucketFor(ids, cc); if (!b || !b.length) return null;
  const a = b.filter((r) => (r.source_priority || 0) >= 100 && !/MFDS/.test(r.source_document || ""));
  return a.length ? a.sort((x, y) => (y.source_priority || 0) - (x.source_priority || 0))[0].status : null;
};

const divergences = []; const seen = new Set();
for (const ing of ingredients) {
  const ids = siblingIds.get(ing.id) ?? new Set([ing.id]);
  const rep = [...ids].sort()[0]; if (seen.has(rep)) continue; seen.add(rep);
  const eu = authStatus(ids, "EU"); if (!eu) continue;
  const off = {};
  for (const grp of Object.keys(GROUPS)) for (const cc of GROUPS[grp]) {
    const s = authStatus(ids, cc);
    if (s && s !== eu) (off[grp] = off[grp] || []).push(`${cc}=${s}`);
  }
  if (Object.keys(off).length) divergences.push({ inci: ing.inci_name, eu, off });
}
divergences.sort((a, b) => (a.inci || "").localeCompare(b.inci || ""));
console.log(`교차출처 권위 status 불일치(검토 후보): ${divergences.length} 물질`);
for (const d of divergences) console.log(`  ${(d.inci || "").slice(0, 30)} EU=${d.eu} | ${Object.entries(d.off).map(([g, v]) => g + ":" + v.join(",")).join(" · ")}`);
console.log(`\n해석: 대부분 정당한 관할권 차이(EU 가 더 엄격·버전 lag). 자동교정 금지(실제 법 — 분별력).`);
console.log(`용도: 검토 큐 + 미래 파서 regression(신규 desync) 조기경보. 신규 항목이 늘면 파싱 점검.`);
if (apply) {
  fs.writeFileSync(path.join(DATA, "cross-source-divergences.json"), JSON.stringify({ generated: "cross-source-consistency", note: "EU-채택국/Mercosur 권위 status desync 검토큐. 대부분 정당한 관할권 차이. 신규 증가=파싱 점검.", count: divergences.length, divergences }, null, 2));
  console.log("\ncross-source-divergences.json 기록.");
}
