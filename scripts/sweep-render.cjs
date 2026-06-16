// 광역 렌더 sweep — 접기 구조 변경의 모바일 가로 overflow / 카드 구조 / 콘솔에러 회귀 검증.
// 위험군(TW·JP 긴 외국어 조건문 보유 성분) 우선 + 광역 샘플. 한 페이지 재사용(fill+Enter).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE = process.env.VERIFY_BASE || "https://tim10000-alt.github.io/cosmetics-reg/";
const N = Number(process.env.SWEEP_N || 200);
const DATA = path.join(__dirname, "..", "public", "data");

// 위험군 성분: TW/JP conditions 에 외국어(긴 조건문 = overflow 위험) 가진 ingredient_id 수집.
const FOREIGN = /[㐀-鿿぀-ヿ]/;
const ing = new Map(JSON.parse(fs.readFileSync(path.join(DATA, "ingredients.json"), "utf8")).rows.map((i) => [i.id, i]));
const risky = new Set();
for (const cc of ["TW", "JP"]) {
  for (const r of JSON.parse(fs.readFileSync(path.join(DATA, "regulations", cc + ".json"), "utf8")).rows) {
    const c = r.conditions;
    if (typeof c === "string" && FOREIGN.test(c) && c.length > 80) risky.add(r.ingredient_id);
  }
}
const names = [];
for (const id of risky) { const i = ing.get(id); if (i && i.inci_name && !FOREIGN.test(i.inci_name)) names.push(i.inci_name); }
// 광역 샘플도 섞기(위험군 외 일반 카드 구조 회귀 확인)
const all = [...ing.values()].filter((i) => i.inci_name && !FOREIGN.test(i.inci_name)).map((i) => i.inci_name);
const sample = [];
const step = Math.max(1, Math.floor(all.length / 60));
for (let i = 0; i < all.length; i += step) sample.push(all[i]);
const queries = [...new Set([...names.slice(0, N - sample.length), ...sample])].slice(0, N);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  const consoleErrs = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text().slice(0, 120)); });
  page.on("pageerror", (e) => consoleErrs.push("PAGEERR " + String(e).slice(0, 120)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const input = page.locator('input[aria-label="화장품 원료 검색"]');
  await input.waitFor({ timeout: 30000 });

  let checked = 0, overflow = 0, noResult = 0, badStruct = 0, anomalies = [];
  for (const q of queries) {
    await input.click(); await input.fill(q); await page.keyboard.press("Enter");
    try {
      await page.waitForFunction(
        () => !!document.querySelector("details[data-country-card]") || /찾지 못했습니다/.test(document.body.innerText),
        null, { timeout: 20000 });
    } catch { noResult++; continue; }
    await page.waitForTimeout(120);
    const res = await page.evaluate(() => {
      const docOver = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const cards = document.querySelectorAll("details[data-country-card]");
      let openByDefault = 0, noBadge = 0;
      for (const c of cards) {
        if (c.open) openByDefault++;
        if (!c.querySelector("summary span.rounded-md")) noBadge++;
      }
      return { docOver, n: cards.length, openByDefault, noBadge };
    });
    if (res.n === 0) { noResult++; continue; }
    checked++;
    if (res.docOver > 2) { overflow++; if (anomalies.length < 12) anomalies.push(`OVERFLOW ${res.docOver}px @ "${q}"`); }
    if (res.openByDefault > 0) { badStruct++; if (anomalies.length < 12) anomalies.push(`OPEN-DEFAULT ${res.openByDefault} @ "${q}"`); }
    if (checked % 25 === 0) console.log(`  ...${checked}/${queries.length} (overflow ${overflow}, openDefault ${badStruct})`);
  }
  console.log(`\n=== 렌더 sweep 결과 (@360px, ${queries.length}성분, 위험군 ${names.length}) ===`);
  console.log(`검사 ${checked} · 무결과 ${noResult} · 가로 overflow ${overflow} · 기본펼침(버그) ${badStruct} · 콘솔에러 ${consoleErrs.length}`);
  if (anomalies.length) { console.log("이상:"); anomalies.forEach((a) => console.log("  " + a)); }
  if (consoleErrs.length) { console.log("콘솔에러 샘플:"); [...new Set(consoleErrs)].slice(0, 5).forEach((e) => console.log("  " + e)); }
  console.log(overflow === 0 && badStruct === 0 && consoleErrs.length === 0 ? "\nSWEEP PASS" : "\nSWEEP 이상 발견");
  await browser.close();
})();
