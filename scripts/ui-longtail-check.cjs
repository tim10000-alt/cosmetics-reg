#!/usr/bin/env node
// 축1 완결: 영문 풀네임으로 self-resolve 안 되는 괄호/복합명(long-tail)을 한글명/부분어로 도달시켜
// 렌더 표기(헤더 INCI·한글·CAS + 대표 카드 status/한도)를 ground-truth 와 1:1. universal-rendering
// 이 어려운 이름에도 faithful 함을 전수 확증.  사용: node scripts/ui-longtail-check.cjs [limit] [conc]
const { chromium } = require("playwright");
const gt = require("./verify-groundtruth.cjs");
const BASE = "http://localhost:3010";
const LIMIT = Number(process.argv[2] || 600), CONC = Number(process.argv[3] || 8);
const norm = (s) => (s == null ? "" : String(s).replace(/\s+/g, " ").trim());
const STATUS = { banned: "배합금지", restricted: "배합한도", listed: "수록 (수출 가능)", allowed: "허용", not_listed: "미수록 (수출 불가)", unknown: "분류 확인 필요" };

const cardBearing = gt.ingredients.filter((i) => { const m = gt.regsByIC.get(i.id); return m && m.size; });
const selfResolve = new Set();
for (const i of gt.ingredients) { if (/[\n\r\t]/.test(i.inci_name || "")) continue; const r = gt.findIngredient(i.inci_name); if (r && r.id === i.id) selfResolve.add(i.id); }
const covered = new Set(); for (const id of selfResolve) for (const s of (gt.siblingIds.get(id) || [id])) covered.add(s);
const uncovered = cardBearing.filter((i) => !selfResolve.has(i.id) && !covered.has(i.id));
function reachQuery(i) {
  if (i.korean_name) { const r = gt.findIngredient(i.korean_name); if (r && (r.id === i.id || (gt.siblingIds.get(r.id) || [r.id]).includes(i.id))) return i.korean_name; }
  const tok = (i.inci_name.replace(/[(),/]/g, " ").split(/\s+/).filter((w) => w.length >= 5).sort((a, b) => b.length - a.length)[0]) || "";
  if (tok) { const r = gt.findIngredient(tok); if (r && (r.id === i.id || (gt.siblingIds.get(r.id) || [r.id]).includes(i.id))) return tok; }
  return null;
}
// 도달 가능한 것만 표본(고르게)
const reachable = uncovered.map((i) => ({ i, q: reachQuery(i) })).filter((x) => x.q);
const step = Math.max(1, Math.floor(reachable.length / LIMIT));
const sample = []; for (let k = 0; k < reachable.length && sample.length < LIMIT; k += step) sample.push(reachable[k]);

let pass = 0, mism = 0; const fails = [];
async function worker(page, items) {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  for (const { i, q } of items) {
    const g = gt.lookup(q); if (!g.ingredient) continue;
    const expTitle = g.ingredient.inci_name;
    let ok = false;
    for (let a = 0; a < 3 && !ok; a++) {
      await page.fill("input", ""); await page.fill("input", q);
      await page.waitForFunction((v) => document.querySelector("input")?.value === v, q, { timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(60); await page.keyboard.press("Enter");
      ok = await page.waitForFunction((e) => { const l = [...document.querySelectorAll("section div")].find((d) => d.textContent.trim() === "INCI"); return l?.nextElementSibling?.textContent?.trim() === e; }, expTitle, { timeout: 4000 }).then(() => true).catch(() => false);
    }
    if (!ok) { fails.push(`${i.inci_name.slice(0, 28)} (q:${q.slice(0, 14)}) RENDER-FAIL`); mism++; continue; }
    const ui = await page.evaluate((STATUS) => {
      const lab = [...document.querySelectorAll("section div")].find((d) => d.textContent.trim() === "INCI");
      const h = {}; document.querySelectorAll("section dl dt").forEach((dt) => h[dt.textContent.trim()] = dt.nextElementSibling?.textContent?.trim());
      let st = null; for (const art of document.querySelectorAll("article")) { for (const s of art.querySelectorAll("span")) { const k = Object.keys(STATUS).find((kk) => STATUS[kk] === s.textContent.trim()); if (k) { st = k; break; } } if (st) break; }
      return { kr: h["한글명"], cas: h["CAS"] };
    }, STATUS);
    let bad = false;
    if (norm(ui.kr) !== norm(g.ingredient.korean_name)) { fails.push(`${expTitle.slice(0,22)} HDR-KR ui="${ui.kr}" gt="${g.ingredient.korean_name}"`); bad = true; }
    if (g.ingredient.cas_no && norm(ui.cas) !== norm(g.ingredient.cas_no)) { fails.push(`${expTitle.slice(0,22)} HDR-CAS`); bad = true; }
    bad ? mism++ : pass++;
  }
}
(async () => {
  console.log(`long-tail 미커버: ${uncovered.length} · 도달가능: ${reachable.length} · 표본 ${sample.length}`);
  const browser = await chromium.launch();
  const pages = []; for (let i = 0; i < CONC; i++) pages.push(await browser.newPage());
  const buckets = Array.from({ length: CONC }, () => []); sample.forEach((x, i) => buckets[i % CONC].push(x));
  await Promise.all(pages.map((p, i) => worker(p, buckets[i])));
  await browser.close();
  console.log(`\n=== long-tail 검증 === pass ${pass} · mismatch ${mism}`);
  fails.slice(0, 20).forEach((f) => console.log("  ❌ " + f));
  process.exit(mism ? 1 : 0);
})();
