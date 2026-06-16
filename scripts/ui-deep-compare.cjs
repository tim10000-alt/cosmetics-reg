#!/usr/bin/env node
// 심층 UI-vs-데이터 대조 — 카드/헤더에 *표기되는 모든 값*을 ground-truth 와 1:1.
// 헤더: INCI·한글·CAS·중국어·일본어·동의어(8)·기능. 카드(국가별): status 라벨·최대배합한도
// 숫자/단위·조건문 텍스트·적용제품·출처 자료명·출처 링크·상속 배지·cascade 추가출처 상세.
// 사용: node scripts/ui-deep-compare.cjs [limit] [conc] [offset]
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const gt = require("./verify-groundtruth.cjs");

// 표시층 번역 미러 — UI 가 translateDisplay(원문→한국어) 로 치환하므로 oracle 도 동일 적용해야
// deep-compare 가 *진짜* 표시버그만 잡는다(번역 거짓불일치 제거). lib/translate-display.ts·strhash.ts 미러.
function strKey(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + "." + s.length.toString(36); }
const TMAP = {
  "TFDA 化粧品禁限用成分管理規定 — 化粧品禁止使用成分表": "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 사용금지 성분표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品防腐劑成分使用限制表": "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 보존제 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品色素成分使用限制表": "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 색소 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品成分使用限制表": "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品防曬劑成分使用限制表": "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 자외선차단제 성분 사용제한표",
  "不得使用於染髮用途化粧品": "염모(헤어 염색)용 화장품에는 사용할 수 없음",
  "用 作 色 素 之 zirconium lakes, salts, pigments 及化粧品成分使用限制表中另有規定者除外。": "색소로 사용되는 지르코늄(zirconium) 레이크·염·안료, 및 화장품 성분 사용제한표에 별도 규정이 있는 경우는 제외.",
  "NMPA IECIC (已使用化妆品原料目录)": "NMPA IECIC (사용된 화장품 원료 목록)",
  "TFDA 化粧品禁限用成分管理規定": "TFDA 화장품 사용금지·제한 성분 관리규정",
  "NMPA 已使用化妆品原料目录 (IECIC)": "NMPA 사용된 화장품 원료 목록 (IECIC)",
  "PMDA 標準成分 검색": "PMDA 표준성분 검색",
  "JP MHLW 化粧品基準 (Standards for Cosmetics, Notification 331)": "JP MHLW 화장품기준 (Standards for Cosmetics, 고시 제331호)",
  "JP MHLW 化粧品基準 別表 1 (品目ごと承認対象成分 positive list)": "JP MHLW 화장품기준 별표1 (품목별 승인대상 성분 positive list)",
};
const TNORM = {}; for (const k of Object.keys(TMAP)) TNORM[k.replace(/\s+/g, " ").trim()] = TMAP[k];
const TCACHE = (() => { try { const t = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "data", "translations.json"), "utf8")).translations || {}; return t; } catch { return {}; } })();
function tr(s) { if (s == null) return s; const c = TCACHE[strKey(s)]; if (c) return c; if (TMAP[s]) return TMAP[s]; const n = TNORM[String(s).replace(/\s+/g, " ").trim()]; if (n) return n; return s; }

const BASE = process.env.UI_BASE || "http://localhost:3010";
const LIMIT = Number(process.argv[2] || 200);
const CONC = Number(process.argv[3] || 6);
const OFFSET = Number(process.argv[4] || 0);

const STATUS_LABEL = { banned: "배합금지", restricted: "배합한도", listed: "수록 (수출 가능)", allowed: "허용", not_listed: "미수록 (수출 불가)", unknown: "분류 확인 필요" };
const NAME_TO_CC = {}; for (const c of gt.countries) NAME_TO_CC[c.name_ko] = c.code;

const norm = (s) => (s == null ? "" : String(s).replace(/\s+/g, " ").trim());
// 조건문 전용: ConditionBlocks 가 \n\n 단락을 별도 div 로 렌더 → textContent 에서 단락
// 구분 공백이 소실됨(시각적으론 정상 분리). 공백은 데이터값이 아니므로 전부 제거 후 내용만 비교.
const normNW = (s) => (s == null ? "" : String(s).replace(/\s+/g, ""));

// production lookupRegulation 미러(inherits 포함, 전체 row + all_sources)
function richLookup(query) {
  const resolved = gt.findIngredient(query);
  if (!resolved) return null;
  const ids = gt.siblingIds.get(resolved.id) ?? [resolved.id];
  const ing = gt.buildCanonical(ids, resolved);  // 표시 성분 = 한국 등록 표준명 대표(production 미러)
  const results = {};
  for (const c of gt.countries) {
    let b = gt.bucketFor(ids, c.code), inh = null;
    if ((!b || !b.length) && c.inherits_from) { const ib = gt.bucketFor(ids, c.inherits_from); if (ib && ib.length) { b = ib; inh = c.inherits_from; } }
    if (b && b.length) { const r = b[0]; results[c.code] = { status: r.status, max: r.max_concentration, unit: r.concentration_unit, conditions: tr(r.conditions), pcats: r.product_categories || [], src: tr(r.source_document), url: r.source_url, inh, all: b }; }
  }
  // production EU-채택 한도 보강 미러: EU 채택국 자국한도 없으면 EU 한도 채택(표시).
  const limRe = /최대\s*농도|배합\s*한도|\d+(\.\d+)?\s*%|\d+,\d+\s*%/;
  const hasLim = (r) => r && (typeof r.max === "number" || (r.conditions && limRe.test(r.conditions)));
  const euR = results["EU"];
  if (euR && hasLim(euR)) {
    for (const cc of Object.keys(results)) {
      const c = gt.countries.find((x) => x.code === cc);
      if (c && c.inherits_from === "EU" && !hasLim(results[cc])) {
        if (typeof euR.max === "number") { results[cc].max = euR.max; results[cc].unit = euR.unit; }
        if (!results[cc].conditions) results[cc].conditions = euR.conditions;
        results[cc].adopted = true;
      }
    }
  }
  return { ing, results, ids };
}

// 전 성분 대상(무규제 포함 — 헤더/not-found 표기까지 검증). 환경변수 CARDS_ONLY=1 이면 규제보유만.
const targets = process.env.CARDS_ONLY ? gt.ingredients.filter((i) => { const m = gt.regsByIC.get(i.id); return m && m.size; }) : gt.ingredients.slice();
const slice = targets.slice(OFFSET, OFFSET + LIMIT);

const mismatches = [];
let checkedIng = 0, checkedCells = 0, skipped = 0;
const cov = { cond: 0, src: 0, url: 0, pcat: 0, casc: 0, inh: 0, maxN: 0, cas: 0, kr: 0, syn: 0, func: 0, fdesc: 0, desc: 0, noReg: 0 }; // 실제 비교 실행 증명
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
      // 기능: sky 배지 + 그 형제 desc span(text-zinc-600). 동의어: zinc-100 배지 spans.
      const sky = sec.querySelector("span[class*='sky-100']");
      out.header.func = sky?.textContent?.trim() || null;
      const fdesc = sky?.parentElement ? [...sky.parentElement.querySelectorAll("span")].find((s) => s !== sky && /zinc-600/.test(s.className)) : null;
      out.header.funcDesc = fdesc?.textContent?.trim() || null;
      out.header.synonyms = [...sec.querySelectorAll("span[class*='bg-zinc-100']")].map((s) => s.textContent.trim()).filter(Boolean);
      const pdesc = sec.querySelector("p[class*='bg-zinc-50']");
      out.header.desc = pdesc?.textContent?.trim() || null;
    }
    // 카드
    document.querySelectorAll("article").forEach((art) => {
      // 접기 UI: 카드 = <article><details data-country-card><summary>(국기+국가명+상속배지+상태칩)…
      // 헤더는 이제 summary(이전 <header> 아님). 국가명은 summary 첫 span.
      const head = art.querySelector(":scope > details > summary") || art.querySelector("summary");
      if (!head) return;
      let nm = (head.querySelector("span")?.textContent || head.textContent || "").replace(/🤖.*$/, "").trim().replace(/[A-Z]{2}\s*상속$/, "").replace(/^[^가-힣A-Za-z]+/, "").trim();
      const cc = NAME_TO_CC[nm];
      if (!cc) return;
      const full = art.textContent;
      // 다른 출처·용도별 규제 details 분리 — 헤드라인(primary) 추출이 추가 블록의 값을 잘못 잡지 않도록
      // 헤드라인 영역(headText)을 그 details 텍스트를 뺀 부분으로 한정.
      let addlDetails = null;
      for (const d of art.querySelectorAll("details")) { const sm = d.querySelector("summary"); if (sm && /다른 출처·용도별 규제/.test(sm.textContent)) { addlDetails = d; break; } }
      const headText = addlDetails ? full.replace(addlDetails.textContent, "") : full;
      // status: 배지 span exact text (추가블록 제외 = 헤드라인 우선)
      let status = null;
      for (const s of art.querySelectorAll("span")) { if (addlDetails && addlDetails.contains(s)) continue; const k = Object.keys(STATUS_LABEL).find((kk) => STATUS_LABEL[kk] === s.textContent.trim()); if (k) { status = k; break; } }
      // max (헤드라인 영역 한정)
      let max = null, unit = null;
      const m = headText.match(/최대 배합한도:\s*([\d.]+)\s*([^\s적출조]*)/);
      if (m) { max = m[1]; unit = (m[2] || "").trim() || null; }
      // 적용 제품 (헤드라인 영역 한정)
      let pcats = null; const pm = headText.match(/적용 제품:\s*([^\n]+?)(?:조건·비고|출처|다른 출처|1차 소스|관련 협회|$)/);
      if (pm) pcats = pm[1].trim();
      // 조건문 (primary 의 "조건·비고" details; 추가블록의 ConditionBlocks 는 summary 없어 제외됨)
      let conditions = null;
      for (const d of art.querySelectorAll("details")) { if (addlDetails && addlDetails.contains(d)) continue; const sm = d.querySelector("summary"); if (sm && sm.textContent.includes("조건·비고")) { conditions = d.textContent.replace(sm.textContent, "").trim(); break; } }
      // 상속 배지
      const inh = (head.textContent.match(/([A-Z]{2})\s*상속/) || [])[1] || null;
      // 출처 자료명 + 링크 (primary = 추가블록 밖 dotted 링크 첫번째)
      let srcDoc = null, srcUrl = null;
      const primaryBlock = [...art.querySelectorAll(":scope > div, :scope > div > div")].find((d) => d.textContent.includes("출처") && !d.closest("details") && !/다른 출처/.test(d.textContent));
      const dotted = [...art.querySelectorAll("a")].filter((a) => !(addlDetails && addlDetails.contains(a)) && /decoration-dotted|underline/.test(a.className));
      if (dotted[0]) { srcDoc = dotted[0].textContent.trim(); srcUrl = dotted[0].getAttribute("href"); }
      else if (primaryBlock) { const sp = [...primaryBlock.querySelectorAll("span")].pop(); if (sp) srcDoc = sp.textContent.trim(); }
      // 다른 출처·용도별 규제 개수 + 항목
      let casc = null;
      const cm = full.match(/다른 출처·용도별 규제 (\d+)건/);
      if (cm) { casc = Number(cm[1]); }
      const cascDocs = [];
      if (addlDetails) addlDetails.querySelectorAll("li").forEach((li) => cascDocs.push(li.textContent.trim()));
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
    // 검색이 이 성분을 포함한 형제그룹으로 resolve 됐는지(canonical 대표는 다른 형제일 수 있음).
    if (!g || !g.ids.includes(ing.id)) { skipped++; continue; }
    const expectTitle = g.ing.inci_name; // 표시 타이틀 = canonical 대표명
    let ok = false;
    for (let a = 0; a < 3 && !ok; a++) {
      await page.fill("input", ""); await page.fill("input", ing.inci_name);
      await page.waitForFunction((v) => document.querySelector("input")?.value === v, ing.inci_name, { timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(50 + a * 70);
      await page.keyboard.press("Enter");
      ok = await page.waitForFunction((e) => { const l = [...document.querySelectorAll("section div")].find((d) => d.textContent.trim() === "INCI"); return l?.nextElementSibling?.textContent?.trim() === e; }, expectTitle, { timeout: 4000 }).then(() => true).catch(() => false);
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
    // 기능 카테고리/설명
    if (g.ing.function_category) { cov.func++; if (norm(ui.header.func) !== norm(g.ing.function_category)) add(`${I} HDR-FUNC ui="${ui.header.func}" gt="${g.ing.function_category}"`); }
    if (g.ing.function_description) { cov.fdesc++; if (norm(ui.header.funcDesc) !== norm(g.ing.function_description)) add(`${I} HDR-FDESC ui="${norm(ui.header.funcDesc).slice(0,30)}" gt="${norm(g.ing.function_description).slice(0,30)}"`); }
    // 설명(description)
    if (g.ing.description) { cov.desc++; if (normNW(ui.header.desc) !== normNW(g.ing.description)) add(`${I} HDR-DESC ui="${norm(ui.header.desc).slice(0,30)}" gt="${norm(g.ing.description).slice(0,30)}"`); }
    // 동의어(첫 8개, 순서)
    if (g.ing.synonyms && g.ing.synonyms.length) { cov.syn++; const exp = g.ing.synonyms.slice(0, 8).map(norm); const got = (ui.header.synonyms || []).map(norm); if (exp.length !== got.length || !exp.every((s, k) => s === got[k])) add(`${I} HDR-SYN ui=[${got.join("|").slice(0,40)}] gt=[${exp.join("|").slice(0,40)}]`); }
    if (Object.keys(g.results).length === 0) cov.noReg++;
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
  try { require("fs").writeFileSync(require("path").join(require("os").tmpdir(), "deepcompare-all.txt"), `성분 ${checkedIng} 셀 ${checkedCells}\n불일치 ${mismatches.length} ${JSON.stringify(byType)}\n` + mismatches.join("\n")); } catch {}
  mismatches.slice(0, 50).forEach((m) => console.log("  ❌ " + m));
  if (mismatches.length > 50) console.log(`  ... +${mismatches.length - 50}`);
  process.exit(mismatches.length ? 1 : 0);
})();
