// "다른 방법" — 전수 차분(differential) 검증. 자기일관성 감사(UI vs 데이터)는 데이터-진실 오류와
// 변경의 부작용을 구조적으로 못 잡는다(오라클이 같은 데이터에서 나오므로). 이 도구는 전 성분 ×
// 전 국가의 "헤드라인"(최고 prio 행의 status,max) 전수를 스냅샷해, 변경 전/후를 비교한다.
// 의도한 변경만 남고 그 외 delta = 부작용 → 전부 표면화. (o-페닐페놀 over-restriction 같은
// 부작용은 이 차분이면 즉시 잡힘. 자기일관성 감사로는 통과돼 못 잡았음.)
//
// 사용:
//   node scripts/headline-snapshot.cjs --write           # baseline(headline-baseline.json) 생성
//   node scripts/headline-snapshot.cjs --diff            # baseline 대비 전수 차분 출력
//   node scripts/headline-snapshot.cjs --diff --flips    # status flip(banned↔허용)만(고신호)
// 개발 규율: 데이터 손대기 전 --write, 손댄 뒤 --diff 로 *모든* 변경 셀을 눈으로 확인.
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "..", "public", "data");
const REGDIR = path.join(DATA, "regulations");
const BASE = path.join(DATA, "headline-baseline.json");

function snapshot() {
  const ings = JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8")).rows;
  const name = new Map(ings.map((i) => [i.id, i.inci_name || i.korean_name || i.id]));
  const snap = {};
  for (const f of fs.readdirSync(REGDIR).filter((x) => x.endsWith(".json"))) {
    const cc = f.replace(".json", "");
    const byId = {};
    for (const r of JSON.parse(fs.readFileSync(path.join(REGDIR, f), "utf8")).rows) (byId[r.ingredient_id] ||= []).push(r);
    for (const [id, rows] of Object.entries(byId)) {
      const top = rows.reduce((a, b) => (((b.source_priority || 0) > (a.source_priority || 0)) ? b : a));
      // 셀 키: cc|id  값: status|max  (전수 — 규제 있는 모든 셀)
      snap[cc + "|" + id] = (top.status || "") + "|" + (top.max_concentration ?? "");
    }
  }
  return { snap, name };
}

function main() {
  const { snap, name } = snapshot();
  const cells = Object.keys(snap).length;
  if (process.argv.includes("--write")) {
    fs.writeFileSync(BASE, JSON.stringify(snap), "utf8");
    console.log(`headline-snapshot: baseline 작성 — ${cells} 셀(규제 있는 전 성분×국가)`);
    return;
  }
  if (process.argv.includes("--diff")) {
    let prev; try { prev = JSON.parse(fs.readFileSync(BASE, "utf8")); } catch { console.error("baseline 없음 — 먼저 --write"); process.exit(2); }
    const flipsOnly = process.argv.includes("--flips");
    const sev = (s) => (s === "banned" ? 3 : s === "restricted" ? 2 : s === "listed" || s === "allowed" ? 1 : 0);
    const ngmap = {}; for (const id of name.keys()) ngmap[id] = name.get(id);
    const changes = [];
    const keys = new Set([...Object.keys(prev), ...Object.keys(snap)]);
    for (const k of keys) {
      const a = prev[k], b = snap[k];
      if (a === b) continue;
      const [cc, id] = k.split("|");
      const [as] = (a || "|").split("|"), [bs] = (b || "|").split("|");
      const flip = sev(as) !== sev(bs) && (as === "banned" || bs === "banned" || as === "" || bs === "");
      if (flipsOnly && !flip) continue;
      changes.push({ cc, name: (name.get(id) || id).slice(0, 40), from: a || "(none)", to: b || "(none)", flip });
    }
    changes.sort((x, y) => (y.flip - x.flip) || x.cc.localeCompare(y.cc));
    console.log(`headline-snapshot --diff: 전수 ${cells} 셀, 변경 ${changes.length}건 (status-flip ${changes.filter((c) => c.flip).length})`);
    for (const c of changes.slice(0, 200)) console.log(`  ${c.flip ? "⚑" : " "} [${c.cc}] ${c.name}: ${c.from} → ${c.to}`);
    if (changes.length > 200) console.log(`  … +${changes.length - 200} more`);
  }
}
main();
