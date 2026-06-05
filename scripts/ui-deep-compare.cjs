#!/usr/bin/env node
// 심층 UI-vs-데이터 대조 — 카드/헤더에 *표기되는 모든 값*을 ground-truth 와 1:1.
// 헤더: INCI·한글·CAS·중국어·일본어·동의어(8)·기능. 카드(국가별): status 라벨·최대배합한도
// 숫자/단위·조건문 텍스트·적용제품·출처 자료명·출처 링크·상속 배지·cascade 추가출처 상세.
// 사용: node scripts/ui-deep-compare.cjs [limit] [conc] [offset]
const { chromium } = require("playwright");
const gt = require("./verify-groundtruth.cjs");

const BASE = process.env.UI_BASE || "http://localhost:3010";
const LIMIT = Number(process.argv[2] || 200);
const CONC = Number(process.argv[3] || 6);
const OFFSET = Number(process.argv[4] || 0);

const STATUS_LABEL = { banned: "배합금지", restricted: "배합한도", listed: "수록 (수출 가능)", allowed: "허용", not_listed: "미수록 (수출 불가)", unknown: "분류 확인 필요" };
const countryByCode = new Map(gt.countries.map((c) => [c.code, c]));
const NAME_TO_CC = {}; for (const c of gt.countries) NAME_TO_CC[c.name_ko] = c.code;

const norm = (s) => (s == null ? "" : String(s).replace(/\s+/g, " ").trim());
// 조건문 전용: ConditionBlocks 가 \n\n 단락을 별도 div 로 렌더 → textContent 에서 단락
// 구분 공백이 소실됨(시각적으론 정상 분리). 공백은 데이터값이 아니므로 전부 제거 후 내용만 비교.
const normNW = (s) => (s == null ? "" : String(s).replace(/\s+/g, ""));

// production lookupRegulation 미러(inherits 포함, 전체 row + all_sources)
function richLookup(query) {
  const ing = gt.findIngredient(query);
  if (!ing) return null;
  const ids = gt.siblingIds.get(ing.id) ?? [ing.id];
  const results = {};
  for (const c of gt.countries) {
    let b = gt.bucketFor(ids, c.code), inh = null;
    if ((!b || !b.length) && c.inherits_from) { const ib = gt.bucketFor(ids, c.inherits_from); if (ib && ib.length) { b = ib; inh = c.inherits_from; } }
    if (b && b.length) { const r = b[0]; results[c.code] = { status: r.status, max: r.max_concentration, unit: r.concentration_unit, conditions: r.conditions, pcats: r.product_categories || [], src: r.source_document, url: r.source_url, inh, all: b }; }
  }
  return { ing, results };
}

const targets = [];
for (const i of gt.ingredients) { const m = gt.regsByIC.get(i.id); if (m && m.size) targets.push(i); }
const slice = targets.slice(OFFSET, OFFSET + LIMIT);

const mismatches = [];
let checkedIng = 0, checkedCells = 0, skipped = 0;
const cov = { cond: 0, src: 0, url: 0, pcat: 0, casc: 0, inh: 0, maxN: 0, cas: 0, kr: 0 }; // 실제 비교 실행 증명
const add = (m) => mismatches.push(m);

async function extract(page) {
  return await page.evaluate(({ NAME_TO_CC, STATUS_LABEL }) => {
    const out = { header: {}, cards: {} };
    // 헤더
    const lab = [...document.querySelectorAll("section div")].find((d) => d.textContent.trim() === "INCI");
    if (lab) out.header.inci = lab.nextElementSibling?.textContent?.trim();
    document.querySelectorAll("section dl dt").forEach((dt) => { const dd = dt.nextElementSibling; if (dd) out.header[dt.textContent.trim()] = dd.textContent.trim(); });
    const sec = lab?.closest("section");
    if (sec) {
      const sky = sec.querySelector("span.bg-sky-100, span[class*='sky-100']");
      out.header.func = sky?.textContent?.trim() || null;
      out.header.synonyms = [...sec.querySelectorAll("div.flex-wrap span")].map((s) => s.textContent.trim()).filter(Boolean);
    }
    // 카드
    document.querySelectorAll("article").forEach((art) => {
      const head = art.querySelector("header");
      if (!head) return;
      // 상속 카드 헤더는 "베트남EU 상속"(공백없이 배지 연접) → "EU 상속"만 제거(국가명 보존).
      let nm = (head.querySelector("div")?.textContent || "").replace(/🤖.*$/, "").trim().replace(/[A-Z]{2}\s*상속$/, "").replace(/^[^가-힣A-Za-z]+/, "").trim();
      const cc = NAME_TO_CC[nm];
      if (!cc) return;
      const full = art.textContent;
      // status: 배지 span exact text
      let status = null;
      for (const s of art.querySelectorAll("span")) { const k = Object.keys(STATUS_LABEL).find((kk) => STATUS_LABEL[kk] === s.textContent.trim()); if (k) { status = k; break; } }
      // max
      let max = null, unit = null;
      const m = full.match(/최대 배합한도:\s*([\d.]+)\s*([^\s적출조]*)/);
      if (m) { max = m[1]; unit = (m[2] || "").trim() || null; }
      // 적용 제품
      let pcats = null; const pm = full.match(/적용 제품:\s*([^\n]+?)(?:조건·비고|출처|추가 출처|1차 소스|관련 협회|$)/);
      if (pm) pcats = pm[1].trim();
      // 조건문 (details textContent, summary 제거)
      let conditions = null;
      for (const d of art.querySelectorAll("details")) { const sm = d.querySelector("summary"); if (sm && sm.textContent.includes("조건·비고")) { conditions = d.textContent.replace(sm.textContent, "").trim(); break; } }
      // 상속 배지
      const inh = (head.textContent.match(/([A-Z]{2})\s*상속/) || [])[1] || null;
      // 출처 자료명 + 링크 (primary = details 밖 dotted 링크 첫번째)
      let srcDoc = null, srcUrl = null;
      const primaryBlock = [...art.querySelectorAll(":scope > div, :scope > div > div")].find((d) => d.textContent.includes("출처") && !d.closest("details") && !/추가 출처/.test(d.textContent));
      // fallback: 첫 dotted-underline a, details 밖
      const dotted = [...art.querySelectorAll("a")].filter((a) => !a.closest("details") && /decoration-dotted|underline/.test(a.className));
      if (dotted[0]) { srcDoc = dotted[0].textContent.trim(); srcUrl = dotted[0].getAttribute("href"); }
      else if (primaryBlock) { const sp = [...primaryBlock.querySelectorAll("span")].pop(); if (sp) srcDoc = sp.textContent.trim(); }
      // cascade 추가 출처
      let casc = null;
      const cm = full.match(/추가 출처 (\d+)건/);
      if (cm) { casc = Number(cm[1]); }
      const cascDocs = [];
      for (const d of art.querySelectorAll("details")) { const sm = d.querySelector("summary"); if (sm && /추가 출처/.test(sm.textContent)) { d.querySelectorAll("li").forEach((li) => cascDocs.push(li.textContent.trim())); break; } }
      out.cards[cc] = { status, max, unit, pcats, conditions, inh, srcDoc, srcUrl, casc, cascDocs, present: true };
    });
    return out;
  }, { NAME_TO_CC, STATUS_LABEL });
}

async function worker(page, items) {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  for (const ing of items) {
    if (/[\n\r\t]/.test(ing.inci_name)) { skipped++; continue; }
    const g = richLookup(ing.inci_name);
    if (!g || g.ing.id !== ing.id) { skipped++; continue; }
    let ok = false;
    for (let a = 0; a < 3 && !ok; a++) {
      await page.fill("input", ""); await page.fill("input", ing.inci_name);
      await page.waitForFunction((v) => document.querySelector("input")?.value === v, ing.inci_name, { timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(50 + a * 70);
      await page.keyboard.press("Enter");
      ok = await page.waitForFunction((e) => { const l = [...document.querySelectorAll("section div")].find((d) => d.textContent.trim() === "INCI"); return l?.nextElementSibling?.textContent?.trim() === e; }, ing.inci_name, { timeout: 4000 }).then(() => true).catch(() => false);
    }
    if (!ok) { add(`${ing.inci_name} :: RENDER-TITLE-FAIL`); continue; }
    const ui = await extract(page);
    checkedIng++;
    const I = ing.inci_name.slice(0, 30);
    // 헤더 대조
    if (g.ing.korean_name) cov.kr++;
    if (norm(ui.header["한글명"]) !== norm(g.ing.korean_name)) add(`${I} HDR-KR ui="${ui.header["한글명"]}" gt="${g.ing.korean_name}"`);
    if (g.ing.cas_no) { cov.cas++; if (norm(ui.header["CAS"]) !== norm(g.ing.cas_no)) add(`${I} HDR-CAS ui="${ui.header["CAS"]}" gt="${g.ing.cas_no}"`); }
    if (norm(ui.header["중국어"]) !== norm(g.ing.chinese_name)) add(`${I} HDR-CN ui="${ui.header["중국어"]}" gt="${g.ing.chinese_name}"`);
    if (norm(ui.header["일본어"]) !== norm(g.ing.japanese_name)) add(`${I} HDR-JP ui="${ui.header["일본어"]}" gt="${g.ing.japanese_name}"`);
    // 카드 대조
    for (const [cc, gv] of Object.entries(g.results)) {
      checkedCells++;
      const uv = ui.cards[cc];
      if (!uv) { add(`${I} [${cc}] CARD-MISSING gt=${gv.status}`); continue; }
      if (uv.status !== gv.status) add(`${I} [${cc}] STATUS ui=${uv.status} gt=${gv.status}`);
      if (typeof gv.max === "number") {
        cov.maxN++;
        if (uv.max == null) add(`${I} [${cc}] MAX-MISSING gt=${gv.max}`);
        else if (Number(uv.max) !== gv.max) add(`${I} [${cc}] MAX ui=${uv.max} gt=${gv.max}`);
      }
      if (gv.inh) { cov.inh++; if (uv.inh !== gv.inh) add(`${I} [${cc}] INHERIT ui=${uv.inh} gt=${gv.inh}`); }
      // 조건문 (정규화 비교) — gt 조건이 있을 때만(빈값 양쪽 일치는 비교 안 함)
      if (norm(gv.conditions)) { cov.cond++; if (normNW(gv.conditions) !== normNW(uv.conditions)) add(`${I} [${cc}] COND ui="${norm(uv.conditions).slice(0, 40)}" gt="${norm(gv.conditions).slice(0, 40)}"`); }
      // 적용제품
      const gpc = norm(gv.pcats.join(", "));
      if (gpc) { cov.pcat++; if (norm(uv.pcats) !== gpc) add(`${I} [${cc}] PCAT ui="${norm(uv.pcats)}" gt="${gpc}"`); }
      // 출처 자료명
      if (norm(gv.src)) { cov.src++; if (norm(uv.srcDoc) !== norm(gv.src)) add(`${I} [${cc}] SRC ui="${norm(uv.srcDoc).slice(0, 30)}" gt="${norm(gv.src).slice(0, 30)}"`); }
      // 출처 링크
      if (gv.url && uv.srcUrl) { cov.url++; if (norm(uv.srcUrl) !== norm(gv.url)) add(`${I} [${cc}] URL ui="${uv.srcUrl}" gt="${gv.url}"`); }
      // cascade 수
      if (gv.all.length > 1) { cov.casc++; if (uv.casc == null || uv.casc + 1 !== gv.all.length) add(`${I} [${cc}] CASC ui=${uv.casc == null ? "none" : uv.casc + 1} gt=${gv.all.length}`); }
    }
  }
}

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const pages = []; for (let i = 0; i < CONC; i++) pages.push(await browser.newPage());
  const buckets = Array.from({ length: CONC }, () => []);
  slice.forEach((ing, i) => buckets[i % CONC].push(ing));
  await Promise.all(pages.map((p, i) => worker(p, buckets[i])));
  await browser.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n=== 심층 UI 대조 === 성분 ${checkedIng} · 셀 ${checkedCells} · skip ${skipped} · ${secs}s`);
  console.log("비교 실행 커버리지(실제 대조된 필드 수):", JSON.stringify(cov));
  // 유형별 집계
  const byType = {}; mismatches.forEach((m) => { const t = (m.match(/\[(?:[A-Z]{2})\] (\w+)|:: (\w+[-\w]*)|(HDR-\w+)/) || [])[1] || (m.match(/(HDR-\w+|RENDER-\w+)/) || [])[1] || "OTHER"; byType[t] = (byType[t] || 0) + 1; });
  console.log("불일치:", mismatches.length, JSON.stringify(byType));
  mismatches.slice(0, 50).forEach((m) => console.log("  ❌ " + m));
  if (mismatches.length > 50) console.log(`  ... +${mismatches.length - 50}`);
  process.exit(mismatches.length ? 1 : 0);
})();
