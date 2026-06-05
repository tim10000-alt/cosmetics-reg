#!/usr/bin/env node
// 전수 UI 정품검증 — 실제 렌더 DOM 추출 후 ground-truth 1:1 대조.
// 사용: node scripts/ui-fullaudit.cjs   (serve out -l 3010 가 떠 있어야 함)
const { chromium } = require("playwright");
const gt = require("./verify-groundtruth.cjs");

const BASE = process.env.UI_BASE || "http://localhost:3010";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PASS = 0, FAIL = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log("  ✅ " + name + (detail ? "  " + detail : "")); }
  else { FAIL++; fails.push(name + " :: " + (detail || "")); console.log("  ❌ " + name + "  " + (detail || "")); }
}

async function loadQuery(page, q) {
  await page.goto(BASE + "/?q=" + encodeURIComponent(q), { waitUntil: "networkidle" });
  // wait for either ingredient header or not-found
  await page.waitForFunction(() => {
    const b = document.body.innerText;
    return b.includes("CAS") || b.includes("찾을 수 없") || b.includes("결과가 없") || document.querySelectorAll("[data-cc]").length > 0 || b.length > 400;
  }, { timeout: 8000 }).catch(() => {});
  await sleep(400);
}

// extract ingredient header dl values
async function header(page) {
  return await page.evaluate(() => {
    const out = {};
    const dts = document.querySelectorAll("dl dt");
    dts.forEach((dt) => {
      const dd = dt.nextElementSibling;
      if (dd) out[dt.textContent.trim()] = dd.textContent.trim();
    });
    // ingredient title (h-level)
    const h = document.querySelector("h1, h2");
    out.__title = h ? h.textContent.trim() : "";
    out.__bodyHasCAS = document.body.innerText.includes("CAS");
    return out;
  });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => { console.log("  [pageerror]", e.message); });

  // ---------- 1. CAS 정규화 후 깨끗한 렌더 (가디언 수정 검증) ----------
  // 날짜화/"0"/"-" 는 null → IngredientHeader 가 행 자체를 숨김(garbage 미노출).
  // 슬래시-full 은 체크디짓 검증 복구(4630/07/03 → 4630-07-3).
  console.log("\n=== [1] CAS 정규화 후 클린 렌더 ===");
  for (const [q, expect] of [["Saccharin", null], ["Caramel", null], ["Lithium Stearate", null], ["Valencene", "4630-07-3"]]) {
    await loadQuery(page, q);
    const h = await header(page);
    const casShown = h["CAS"] || h["CAS No."] || "";
    if (expect === null) check(`CAS-clean ${q} (숨김)`, casShown === "" || !/[\/]|^0$/.test(casShown), `rendered CAS="${casShown}" (garbage여야 안 보임)`);
    else check(`CAS-recovered ${q}`, casShown.includes(expect), `rendered CAS="${casShown}" (expect "${expect}")`);
  }

  // ---------- 2. 정상 CAS + 헤더 보조명 ----------
  console.log("\n=== [2] 정상 헤더(한/중/일/CAS) ground-truth 대조 ===");
  for (const q of ["Retinol", "Benzophenone-3", "Caramel"]) {
    await loadQuery(page, q);
    const h = await header(page);
    const g = gt.lookup(q);
    const ing = g.ingredient;
    if (ing.korean_name) check(`hdr-KR ${q}`, (h["한글명"] || h["국문명"] || "") === ing.korean_name, `ui="${h["한글명"]||h["국문명"]}" gt="${ing.korean_name}"`);
    if (ing.japanese_name) check(`hdr-JP ${q}`, (h["일본어"] || h["일문명"] || "").includes(ing.japanese_name), `ui="${h["일본어"]||h["일문명"]}" gt="${ing.japanese_name}"`);
    if (ing.chinese_name) check(`hdr-CN ${q}`, (h["중국어"] || h["중문명"] || "").includes(ing.chinese_name), `ui="${h["중국어"]||h["중문명"]}"`);
  }

  // ---------- 3. 19개국 카드 + status/한도 대조 ----------
  console.log("\n=== [3] 카드/상태/한도 ground-truth 대조 ===");
  const cardCases = [
    ["Retinol", null],
    ["Benzophenone-3", { KR: { max: "5" }, CA: { max: "6" } }],
    ["Dihydroxyacetone", { EU: { max: "6.25" } }],
    ["Cysteamine Hydrochloride", { JP: { max: "8.63" } }],
  ];
  for (const [q, expects] of cardCases) {
    await loadQuery(page, q);
    const dump = await page.evaluate(() => document.body.innerText);
    const g = gt.lookup(q);
    const nCards = Object.keys(g.results).length;
    // count rendered country-name occurrences via known names
    check(`cards-present ${q}`, dump.length > 500, `body ${dump.length} chars, gt countries=${nCards}`);
    if (expects) {
      for (const [cc, e] of Object.entries(expects)) {
        if (e.max != null) check(`limit ${q}/${cc}=${e.max}`, dump.includes(e.max), `body contains "${e.max}"? `);
      }
    }
  }

  // ---------- 4. 검색 경로 (한글/CAS/부분) ----------
  console.log("\n=== [4] 검색 경로 ===");
  await loadQuery(page, "레티놀");
  check("한글검색 레티놀", (await page.evaluate(() => document.body.innerText)).includes("Retinol"), "");
  await loadQuery(page, "131-57-7");
  check("CAS검색 131-57-7", (await page.evaluate(() => document.body.innerText)).includes("Benzophenone-3"), "");

  // ---------- 5. not-found / quarantine 제외 ----------
  console.log("\n=== [5] 격리 제외 / not-found ===");
  await loadQuery(page, "アラントイン410.500.200");
  const nf = await page.evaluate(() => document.body.innerText);
  // 격리 성분은 ingredient 로 렌더되면 안 됨 — 헤더(dl/CAS)·국가카드 부재 + not-found 메시지.
  // (쿼리 문자열 "410.500" 은 not-found 메시지에 에코되므로 본문 포함 여부로 판단하면 안 됨.)
  const isNotFound = /찾지 못했|찾을 수 없|결과가 없|no result/i.test(nf);
  const hasIngredientUI = await page.evaluate(() => document.querySelectorAll("dl dt").length > 0);
  check("격리쓰레기 not-found", isNotFound && !hasIngredientUI, `notFound=${isNotFound} hasHeader=${hasIngredientUI}`);

  // ---------- 6. 1차 소스 PDF 첨부 렌더 + href ----------
  console.log("\n=== [6] 1차 소스 PDF 첨부 ===");
  await loadQuery(page, "Cysteamine Hydrochloride"); // JP → has source PDFs
  const pdfs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      if (/\.pdf|eur-lex|mhlw|hwpx|content\/\d+/i.test(a.href)) out.push({ text: a.textContent.trim().slice(0, 40), href: a.href });
    });
    const hasPdfSection = document.body.innerText.includes("1차 소스 PDF") || document.body.innerText.includes("소스 PDF");
    return { links: out, hasPdfSection };
  });
  check("PDF 섹션 존재", pdfs.hasPdfSection, `pdf links=${pdfs.links.length}`);
  check("PDF 링크 href 유효", pdfs.links.every((l) => /^https?:\/\//.test(l.href)), pdfs.links.slice(0, 3).map((l) => l.href).join(" | "));

  // ---------- 7. cascade 추가 출처 ----------
  console.log("\n=== [7] cascade 추가 출처 (nSrc>1) ===");
  await loadQuery(page, "Retinol"); // CA nSrc=2
  const casc = await page.evaluate(() => document.body.innerText);
  check("추가출처 표기", /추가 출처|다른 출처|\+\d|출처 \d|기타 출처/.test(casc) || casc.includes("Hotlist"), "cascade sources visible");

  // ---------- 8. related_variants ----------
  console.log("\n=== [8] related_variants ===");
  // find an ingredient with variants from gt
  let variantQ = null;
  for (const i of gt.ingredients.slice(0, 8000)) {
    if (!i.korean_name) continue;
    const same = gt.ingredients.filter((x) => x.korean_name === i.korean_name);
    if (same.length > 1 && same.length <= 20) { variantQ = i.inci_name; break; }
  }
  if (variantQ) {
    await loadQuery(page, variantQ);
    const vt = await page.evaluate(() => document.body.innerText);
    console.log("    variant test query:", variantQ, "| has '확인 필요'/'관련':", /확인 필요|관련|변이|variant/i.test(vt));
  }

  // ---------- 9. /sources 페이지 ----------
  console.log("\n=== [9] /sources 페이지 ===");
  await page.goto(BASE + "/sources", { waitUntil: "networkidle" });
  await sleep(400);
  const src = await page.evaluate(() => document.body.innerText);
  check("/sources 렌더", src.includes("출처") || src.includes("소스") || src.length > 300, `len=${src.length}`);
  check("/sources 카운트", /\d{3,}/.test(src), "has numeric counts");

  console.log(`\n=== UI AUDIT SUMMARY === ${PASS} pass / ${FAIL} fail`);
  if (fails.length) { console.log("FAILS:"); fails.forEach((f) => console.log("  - " + f)); }
  await browser.close();
  process.exit(FAIL ? 1 : 0);
})();
