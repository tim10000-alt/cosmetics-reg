#!/usr/bin/env node
// status 교정 UI 전수 실증 — KR banned+한도 오분류 후보 144건을 *전부* 실제 렌더 국가카드 배지와 1:1.
//  · override(교정) 대상 → "배합한도"(restricted) 로 떠야
//  · 그 외(veto/검토큐/미판정) → "배합금지"(banned) 유지(거짓 교정 0)
//  · 비후보 KR 성분 표본 → 영향 0(spillover)
// (serve out -l 3010 필요.) 사용: node scripts/ui-status-check.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const D = path.join(__dirname, "..", "public", "data");
const J = (f) => JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));
const BASE = process.env.UI_BASE || "http://localhost:3010";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ing = J("ingredients.json").rows;
const byId = new Map(ing.map((i) => [i.id, i]));
const KRNAME = (J("countries.json").rows.find((c) => c.code === "KR") || {}).name_ko || "대한민국";
const LABEL = { banned: "배합금지", restricted: "배합한도", allowed: "허용", listed: "수록 (수출 가능)" };
const LIMIT = /배합한도|최대사용농도|허용된 최대농도/;

const kr = J("regulations/KR.json").rows;
const overrides = (J("status-overrides.json").corrections || []);
const corrSet = new Set(overrides.map((c) => `${c.ingredient_id}:${c.country_code}`));

// 후보 144 = banned + MFDS + 한도텍스트
const candidates = kr.filter((r) => r.status === "banned" && (r.source_document || "").includes("MFDS") && r.conditions && LIMIT.test(r.conditions));
// 비후보 spillover 표본: KR restricted/banned 인데 후보 아닌 것 + 다른 흔한 성분
const candIds = new Set(candidates.map((r) => r.ingredient_id));
const spillSample = kr.filter((r) => !candIds.has(r.ingredient_id) && (r.status === "banned" || r.status === "restricted")).slice(0, 20);

let PASS = 0, FAIL = 0; const fails = [];
function check(name, cond, detail) {
  if (cond) PASS++; else { FAIL++; fails.push(name + " :: " + (detail || "")); }
  if (!cond) console.log("  ❌ " + name + "  " + (detail || ""));
}

async function cardStatus(page, q) {
  try {
    await page.goto(BASE + "/?q=" + encodeURIComponent(q), { waitUntil: "networkidle", timeout: 15000 });
  } catch {
    // serve 일시 끊김 등 — 한 번 재시도 후에도 실패면 표식 반환(크래시 방지)
    await sleep(1500);
    try { await page.goto(BASE + "/?q=" + encodeURIComponent(q), { waitUntil: "domcontentloaded", timeout: 15000 }); }
    catch { return "(nav실패)"; }
  }
  await page.waitForFunction(() => document.querySelectorAll("article").length > 0 || /찾을 수 없|결과가 없/.test(document.body.innerText), { timeout: 9000 }).catch(() => {});
  await sleep(250);
  return await page.evaluate((cn) => {
    const labels = ["배합금지", "배합한도", "허용", "수록 (수출 가능)", "미수록 (수출 불가)"];
    for (const art of document.querySelectorAll("article")) {
      const head = art.querySelector("header");
      if (!head || !head.textContent.includes(cn)) continue;
      for (const sp of art.querySelectorAll("span")) {
        const t = sp.textContent.trim();
        if (labels.includes(t)) return t;
      }
      return "(배지없음)";
    }
    return "(카드없음)";
  }, KRNAME);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  console.log(`\n=== KR 후보 ${candidates.length}건 전수 UI 대조 (교정 ${corrSet.size}) ===`);
  let nCorr = 0, nKeep = 0;
  for (const r of candidates) {
    const ig = byId.get(r.ingredient_id);
    if (!ig || !ig.inci_name) { check(`후보 ${r.ingredient_id}`, false, "성분/이름 없음"); continue; }
    const corrected = corrSet.has(`${r.ingredient_id}:KR`);
    const expect = corrected ? LABEL.restricted : LABEL.banned;
    // 검색 도달용 쿼리: inci_name → korean_name → CAS (그룹/쉼표/괄호명 도달 보강)
    const unreached = (g) => g === "(카드없음)" || g === "(배지없음)" || g === "(nav실패)";
    let got = await cardStatus(page, ig.inci_name);
    if (unreached(got) && ig.korean_name) got = await cardStatus(page, ig.korean_name);
    if (unreached(got) && ig.cas_no) { const cas = (ig.cas_no.match(/\d{2,7}-\d{2}-\d/) || [])[0]; if (cas) got = await cardStatus(page, cas); }
    check(`${ig.inci_name} [KR] expect ${expect}`, got === expect, `corrected=${corrected} rendered="${got}" (검색도달불가일수있음)`);
    if (corrected) nCorr++; else nKeep++;
    if ((nCorr + nKeep) % 20 === 0) console.log(`  …진행 ${nCorr + nKeep}/${candidates.length} (PASS ${PASS} FAIL ${FAIL})`);
  }
  console.log(`  교정 확인 ${nCorr} · 금지유지 확인 ${nKeep}`);

  console.log(`\n=== spillover: 비후보 KR ${spillSample.length}건 (raw status 유지) ===`);
  for (const r of spillSample) {
    const ig = byId.get(r.ingredient_id);
    if (!ig || !ig.inci_name) continue;
    let got = await cardStatus(page, ig.inci_name);
    if ((got === "(카드없음)" || got === "(배지없음)") && ig.korean_name) got = await cardStatus(page, ig.korean_name);
    const expect = LABEL[r.status] || null;
    // 비후보는 override 무관 → raw status 그대로(배지없음/카드없음은 검색도달 한계라 skip 처리)
    if (got === "(카드없음)" || got === "(배지없음)") continue;
    check(`spillover ${ig.inci_name} [KR] raw=${r.status}`, expect ? got === expect : true, `rendered="${got}"`);
  }

  await browser.close();
  console.log(`\n결과: PASS ${PASS} · FAIL ${FAIL}`);
  if (FAIL) { console.log("--- 실패 상세 ---\n" + fails.join("\n")); process.exit(1); }
})();
