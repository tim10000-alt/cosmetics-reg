// 전수 렌더 sweep — 전 성분(약 3.5만)을 @360px 실제 렌더해 가로 overflow / 접기 구조 /
// 콘솔에러를 하나하나 검사. 데이터 1회 로드 후 fill+Enter 재사용(인메모리, 페이지 reload 없음).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE = process.env.VERIFY_BASE || "http://localhost:3010/";
const LOG = path.join(__dirname, "..", "_sweepfull.log");

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "data", "ingredients.json"), "utf8")).rows;
// 검색어 = INCI(없으면 korean). 중복 제거. 전 성분 커버.
const seen = new Set();
const queries = [];
for (const r of rows) {
  const q = (r.inci_name || r.korean_name || "").trim();
  if (q && !seen.has(q)) { seen.add(q); queries.push(q); }
}

const log = (m) => { console.log(m); fs.appendFileSync(LOG, m + "\n"); };

(async () => {
  fs.writeFileSync(LOG, `전수 sweep 시작: ${queries.length} 쿼리 (전 성분 ${rows.length})\n`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  const consoleErrs = new Set();
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.add(m.text().slice(0, 140)); });
  page.on("pageerror", (e) => consoleErrs.add("PAGEERR " + String(e).slice(0, 140)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const input = page.locator('input[aria-label="화장품 원료 검색"]');
  await input.waitFor({ timeout: 30000 });
  // 최초 1회 검색으로 데이터 로드 완료까지 대기.
  await input.click(); await input.fill(queries[0]); await page.keyboard.press("Enter");
  await page.locator("details[data-country-card]").first().waitFor({ timeout: 120000 });

  let checked = 0, noResult = 0, overflowCnt = 0, openDefaultCnt = 0, maxOver = 0;
  const anomalies = [];
  const t0 = Date.now();
  for (let idx = 0; idx < queries.length; idx++) {
    const q = queries[idx];
    await input.fill(q);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(70);
    let res;
    try {
      res = await page.evaluate(() => {
        const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const cards = document.querySelectorAll("details[data-country-card]");
        const noRes = /찾지 못했습니다/.test(document.body.innerText);
        let open = 0;
        for (const c of cards) if (c.open) open++;
        return { over, n: cards.length, open, noRes };
      });
    } catch { continue; }
    if (res.n === 0) { if (res.noRes) noResult++; else { await page.waitForTimeout(150); idx--; } continue; }
    checked++;
    if (res.over > 2) { overflowCnt++; maxOver = Math.max(maxOver, res.over); if (anomalies.length < 40) anomalies.push(`OVERFLOW ${res.over}px @ "${q}"`); }
    if (res.open > 0) { openDefaultCnt++; if (anomalies.length < 40) anomalies.push(`OPEN-DEFAULT ${res.open} @ "${q}"`); }
    if (checked % 1000 === 0) {
      const rate = checked / ((Date.now() - t0) / 1000);
      log(`  ...${checked}/${queries.length} (overflow ${overflowCnt}, openDefault ${openDefaultCnt}, noResult ${noResult}, ${rate.toFixed(1)}/s, err ${consoleErrs.size})`);
    }
  }
  log(`\n=== 전수 sweep 완료 @360px ===`);
  log(`검사 ${checked} · 무결과 ${noResult} · 가로 overflow ${overflowCnt}(max ${maxOver}px) · 기본펼침버그 ${openDefaultCnt} · 콘솔에러종류 ${consoleErrs.size}`);
  if (anomalies.length) { log("이상:"); anomalies.forEach((a) => log("  " + a)); }
  if (consoleErrs.size) { log("콘솔에러:"); [...consoleErrs].slice(0, 10).forEach((e) => log("  " + e)); }
  log(overflowCnt === 0 && openDefaultCnt === 0 && consoleErrs.size === 0 ? "\nFULL SWEEP PASS" : "\nFULL SWEEP 이상 발견");
  await browser.close();
})();
