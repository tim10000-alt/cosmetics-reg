#!/usr/bin/env node
// 국가별 고정 표기자료 대조 — 성분 무관하게 카드에 붙는 자료들:
//  1차 소스 PDF 목록(sources-pdf.json) · KCIA 협회자료 링크(kcia-articles.json, top5) · 등록목록 링크(countries.json)
// 이 자료들은 모든 성분의 해당국 카드에 동일 표기 → 성분 1개 로드로 19국 전수 검증.
const { chromium } = require("playwright");
const fs = require("fs"); const path = require("path");
const D = path.join(__dirname, "..", "public", "data");
const J = (f) => JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));
const BASE = process.env.UI_BASE || "http://localhost:3010";

const countries = J("countries.json").rows;
const pdfs = (J("sources-pdf.json").rows || []);
const kcia = (J("kcia-articles.json").rows || J("kcia-articles.json"));
const NAME = {}; countries.forEach((c) => NAME[c.code] = c.name_ko);

// 기대값: 국가별 PDF url set, KCIA url set(top5), registry url
const pdfByCC = {}; for (const r of pdfs) (pdfByCC[r.country] ??= []).push(r.url);
// KCIA: data-loader 와 동일 — country_inferred 그룹 + date desc 정렬, 카드는 top5, 링크=detail_url
const kciaArr = Array.isArray(kcia) ? kcia : (kcia.rows || []);
const kciaByCC = {};
for (const a of kciaArr) { if (a.country_inferred) (kciaByCC[a.country_inferred] ??= []).push(a); }
for (const cc in kciaByCC) kciaByCC[cc] = kciaByCC[cc].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, 5).map((a) => a.detail_url);

let pass = 0, fail = 0; const fails = [];
const ck = (n, c, d) => { c ? pass++ : (fail++, fails.push(n + " :: " + d)); console.log((c ? "  ✅ " : "  ❌ ") + n + (d ? "  " + d : "")); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // 광범위 커버 성분(많은 국가 카드). Benzophenone-3 사용(19국 다수 verified).
  await page.goto(BASE + "/?q=Benzophenone-3", { waitUntil: "networkidle" });
  await page.waitForSelector("article", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 600));
  const rendered = await page.evaluate((NAME) => {
    const out = {};
    document.querySelectorAll("article").forEach((art) => {
      const nm = (art.querySelector("header div")?.textContent || "").replace(/🤖.*$/, "").replace(/[A-Z]{2}\s*상속$/, "").replace(/^[^가-힣A-Za-z]+/, "").trim();
      const cc = Object.keys(NAME).find((k) => NAME[k] === nm);
      if (!cc) return;
      const links = [...art.querySelectorAll("a")];
      const pdfLinks = links.filter((a) => /1차 소스 PDF/.test(a.closest("details")?.querySelector("summary")?.textContent || "")).map((a) => a.href);
      // PDF: details summary "1차 소스 PDF"
      let pdfUrls = [], kciaUrls = [], registry = null;
      for (const d of art.querySelectorAll("details")) {
        const sm = d.querySelector("summary")?.textContent || "";
        if (/1차 소스 PDF/.test(sm)) pdfUrls = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href"));
        if (/관련 협회 자료/.test(sm)) kciaUrls = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      }
      const reg = links.find((a) => /등록 원료 목록/.test(a.textContent));
      if (reg) registry = reg.getAttribute("href");
      out[cc] = { pdfUrls, kciaUrls, registry };
    });
    return out;
  }, NAME);

  for (const c of countries) {
    const cc = c.code; const r = rendered[cc];
    if (!r) { ck(`[${cc}] 카드 렌더`, false, "카드 없음"); continue; }
    // PDF set 대조
    const expPdf = new Set(pdfByCC[cc] || []);
    const gotPdf = new Set(r.pdfUrls);
    const pdfOk = expPdf.size === gotPdf.size && [...expPdf].every((u) => gotPdf.has(u));
    ck(`[${cc}] 1차 PDF (${expPdf.size}건)`, pdfOk, pdfOk ? "" : `ui=${[...gotPdf].length} exp=${expPdf.size} :: ${[...expPdf][0] || ""}`);
    // KCIA top5 대조 (순서까지 — date desc top5, 링크=detail_url)
    const expK = (kciaByCC[cc] || []);
    const kOk = r.kciaUrls.length === expK.length && r.kciaUrls.every((u, i) => u === expK[i]);
    ck(`[${cc}] KCIA 자료 (${expK.length}건)`, kOk, kOk ? "" : `ui=[${r.kciaUrls.length}] exp=[${expK.length}] :: ${expK[0] || "(none)"}`);
    // registry (positive_list/hybrid 만)
    if (c.regulation_type === "positive_list" || c.regulation_type === "hybrid") {
      ck(`[${cc}] 등록목록 링크`, r.registry === c.registry_url, r.registry === c.registry_url ? "" : `ui=${r.registry} exp=${c.registry_url}`);
    }
  }
  console.log(`\n=== 국가별 고정자료 대조 === ${pass} pass / ${fail} fail`);
  fails.forEach((f) => console.log("  - " + f));
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
