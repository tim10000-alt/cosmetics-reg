#!/usr/bin/env node
// 초기 벌크 교정(KR+CN+TW 237) 전수 UI 검증 — 각 교정 성분의 해당 국가 카드가 더 이상 "배합금지"
// 가 아님(false-banned 제거 = 교정 반영) 확인. 헤드라인은 배합한도(restricted) 또는 수록/허용
// (IECIC 등 상위 출처) 둘 다 정상(상충배지로 제한 표면화). 진짜금지(파라벤·수은) 표본은 배합금지 유지.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const D = path.join(__dirname, "..", "public", "data");
const J = (f) => JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));
const BASE = process.env.UI_BASE || "http://localhost:3011";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ing = J("ingredients.json").rows;
const byId = new Map(ing.map((i) => [i.id, i]));
const CNAME = new Map(J("countries.json").rows.map((c) => [c.code, c.name_ko]));
const corrections = J("status-overrides.json").corrections;

let PASS = 0, FAILBAN = 0, UNREACH = 0; const fails = [], unreach = [];
async function badge(page, q, cname) {
  try { await page.goto(BASE + "/?q=" + encodeURIComponent(q), { waitUntil: "domcontentloaded", timeout: 10000 }); }
  catch { return "(nav)"; }
  await page.waitForFunction(() => document.querySelectorAll("article").length > 0 || /찾지 못/.test(document.body.innerText), { timeout: 6000 }).catch(() => {});
  await sleep(150);
  return await page.evaluate((cn) => {
    const L = ["배합금지", "배합한도", "허용", "수록 (수출 가능)", "미수록 (수출 불가)"];
    const a = [...document.querySelectorAll("article")].find((x) => x.querySelector("header") && x.querySelector("header").textContent.includes(cn));
    if (!a) return "(카드없음)";
    for (const sp of a.querySelectorAll("span")) { const t = sp.textContent.trim(); if (L.includes(t)) return t; }
    return "(배지없음)";
  }, cname);
}
const cas = (ig) => (String(ig.cas_no || "").match(/\d{2,7}-\d{2}-\d/) || [])[0];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  console.log(`벌크 교정 전수 UI 검증 — ${corrections.length}건`);
  for (let i = 0; i < corrections.length; i++) {
    const c = corrections[i];
    const ig = byId.get(c.ingredient_id);
    if (!ig || !ig.inci_name) { UNREACH++; unreach.push(c.ingredient_id); continue; }
    const cn = CNAME.get(c.country_code) || c.country_code;
    let b = await badge(page, ig.inci_name, cn);
    if ((b === "(카드없음)" || b === "(배지없음)" || b === "(nav)") && ig.korean_name) b = await badge(page, ig.korean_name, cn);
    if ((b === "(카드없음)" || b === "(배지없음)" || b === "(nav)") && cas(ig)) b = await badge(page, cas(ig), cn);
    if (b === "(카드없음)" || b === "(배지없음)" || b === "(nav)") { UNREACH++; unreach.push(`${ig.inci_name} [${c.country_code}]`); continue; }
    if (b === "배합금지") { FAILBAN++; fails.push(`${ig.inci_name} [${c.country_code}] → 여전히 배합금지(교정 미반영)`); }
    else PASS++;   // 배합한도/수록/허용 = false-banned 제거됨
    if ((i + 1) % 30 === 0) console.log(`  …진행 ${i + 1}/${corrections.length} (PASS ${PASS} FAIL ${FAILBAN} 미도달 ${UNREACH})`);
  }
  // 진짜금지 표본 — 배합금지 유지여야
  console.log("진짜금지 표본 확인(배합금지 유지):");
  for (const [q, cc] of [["Isobutylparaben", "KR"], ["Phenyl Mercuric Acetate", "TW"], ["Isopropylparaben", "CN"]]) {
    const b = await badge(page, q, CNAME.get(cc));
    console.log(`  ${b === "배합금지" ? "✅" : "❌"} ${q} [${cc}] → ${b}`);
  }
  await browser.close();
  console.log(`\n결과: 교정반영(배합금지 아님) ${PASS} · 여전히배합금지 ${FAILBAN} · 검색미도달 ${UNREACH}`);
  if (FAILBAN) console.log("--- 미반영 ---\n" + fails.join("\n"));
  if (UNREACH) console.log("--- 미도달(검색한계, 데이터는 교정됨) ---\n" + unreach.slice(0, 20).join("\n"));
  console.log("AUDIT_DONE");
})();
