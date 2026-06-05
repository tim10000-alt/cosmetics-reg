#!/usr/bin/env node
// 대량 UI-vs-데이터 1:1 대조. 렌더된 각 국가 카드(status 라벨·한도·단위·추가출처수)를
// ground-truth 와 전수 비교. serve out -l 3010 필요.
// 사용: node scripts/ui-bulk-compare.cjs [limit] [concurrency] [offset]
const { chromium } = require("playwright");
const gt = require("./verify-groundtruth.cjs");

const BASE = process.env.UI_BASE || "http://localhost:3010";
const LIMIT = Number(process.argv[2] || 300);
const CONC = Number(process.argv[3] || 6);
const OFFSET = Number(process.argv[4] || 0);

const STATUS_LABEL = { banned: "배합금지", restricted: "배합한도", listed: "수록 (수출 가능)", allowed: "허용", not_listed: "미수록 (수출 불가)", unknown: "분류 확인 필요" };
const NAME_TO_CC = {};
for (const c of gt.countries) NAME_TO_CC[c.name_ko] = c.code;

// 카드 있는 성분만 대상(verified 1개 이상)
const targets = [];
for (const i of gt.ingredients) { const m = gt.regsByIC.get(i.id); if (m && m.size) targets.push(i); }
const slice = targets.slice(OFFSET, OFFSET + LIMIT);

const mismatches = [];
let checkedIng = 0, checkedCells = 0;

async function extractCards(page) {
  return await page.evaluate((NAME_TO_CC) => {
    const cards = {};
    document.querySelectorAll("article").forEach((art) => {
      const head = art.querySelector("header");
      if (!head) return;
      // 국가명: 헤더 첫 div 텍스트에서 국기·상속배지·🤖시간 제거
      let nm = (head.querySelector("div")?.textContent || "").replace(/🤖.*$/, "").replace(/\S+\s*상속/, "").trim();
      // 국기 이모지 등 앞쪽 비한글 제거
      nm = nm.replace(/^[^가-힣A-Za-z]+/, "").trim();
      const cc = NAME_TO_CC[nm];
      if (!cc) return;
      const txt = art.innerText;
      // status: 배지 <span> 의 *정확한* 텍스트로 추출. (카드 본문의 "최대 배합한도:" 와
      // restricted 라벨 "배합한도" 가 부분일치하므로 whole-text 스캔은 오판 — 반드시 exact.)
      const LAB = { "배합금지": "banned", "배합한도": "restricted", "수록 (수출 가능)": "listed", "허용": "allowed", "미수록 (수출 불가)": "not_listed", "분류 확인 필요": "unknown" };
      let status = null;
      for (const s of art.querySelectorAll("span")) {
        const k = LAB[s.textContent.trim()];
        if (k) { status = k; break; }
      }
      // 최대 배합한도: 숫자형
      let max = null, unit = null;
      const m = txt.match(/최대 배합한도:\s*([\d.]+)\s*(\S*)/);
      if (m) { max = m[1]; unit = m[2] || null; }
      const addM = txt.match(/추가 출처 (\d+)건/);
      const addSources = addM ? Number(addM[1]) : 0;
      const notFound = /등재 정보 없음|미수록|확인되지 않|검색되지|규제 정보 없음/.test(txt) && status === null;
      cards[cc] = { status, max, unit, addSources, hasCard: true };
    });
    return cards;
  }, NAME_TO_CC);
}

let skipped = 0;
async function worker(page, items, wid) {
  // 데이터셋 1회 로드(첫 네비게이션). 이후 인메모리 검색만 반복(고속).
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  for (const ing of items) {
    const g = gt.lookup(ing.inci_name);
    // ground-truth 가 동일 성분으로 resolve 됐는지 확인(fuzzy 불일치 시 skip — 비교 무의미)
    if (!g.ingredient || g.ingredient.id !== ing.id) { skipped++; continue; }
    // 개행/제어문자 박힌 inci_name(그룹엔트리 데이터 아티팩트)은 단일행 입력에 타이핑 불가
    // → harness 한계로 skip. (deeplink ?q= 실경로로는 정상 렌더됨을 별도 확인.)
    if (/[\n\r\t]/.test(ing.inci_name)) { skipped++; continue; }
    // 입력창에 타이핑 + Enter → 인메모리 lookup. INCI 타이틀이 기댓값으로 바뀔 때까지 폴링.
    // (fill 은 DOM값만 즉시 설정 → React onChange 커밋 전 Enter 발火 시 query 가 stale → settle 대기 + 재시도.)
    const titleIs = (expected) => page.waitForFunction((exp) => {
      const lab = [...document.querySelectorAll("div")].find((d) => d.textContent.trim() === "INCI");
      return lab?.nextElementSibling?.textContent?.trim() === exp;
    }, expected, { timeout: 4000 }).then(() => true).catch(() => false);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      await page.fill("input", "");
      await page.fill("input", ing.inci_name);
      // input 의 DOM value 가 실제로 반영됐는지 확인(React onChange 커밋 대기)
      await page.waitForFunction((v) => document.querySelector("input")?.value === v, ing.inci_name, { timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(60 + attempt * 80);  // 부하 시 점증 백오프
      await page.keyboard.press("Enter");
      ok = await titleIs(ing.inci_name);
    }
    if (!ok) { mismatches.push(`${ing.inci_name} RENDER-TITLE-MISMATCH (UI 가 다른 성분으로 resolve/미표시)`); continue; }
    const cards = await extractCards(page);
    checkedIng++;
    for (const [cc, gv] of Object.entries(g.results)) {
      checkedCells++;
      const uv = cards[cc];
      if (!uv || !uv.hasCard) { mismatches.push(`${ing.inci_name} [${cc}] CARD-MISSING (gt ${gv.status})`); continue; }
      // status 라벨 대조
      if (uv.status !== gv.status) mismatches.push(`${ing.inci_name} [${cc}] STATUS ui=${uv.status} gt=${gv.status}`);
      // 한도 숫자 대조 (gt.max 가 숫자일 때)
      if (typeof gv.max === "number") {
        if (uv.max == null) mismatches.push(`${ing.inci_name} [${cc}] MAX-MISSING gt=${gv.max}${gv.unit || ""}`);
        else if (Number(uv.max) !== gv.max) mismatches.push(`${ing.inci_name} [${cc}] MAX ui=${uv.max} gt=${gv.max}`);
        else if (gv.unit && uv.unit && uv.unit !== gv.unit) mismatches.push(`${ing.inci_name} [${cc}] UNIT ui=${uv.unit} gt=${gv.unit}`);
      }
      // 추가 출처 수: ui addSources + 1 == gt nSources
      if (gv.nSources > 1 && uv.addSources + 1 !== gv.nSources) mismatches.push(`${ing.inci_name} [${cc}] NSRC ui=${uv.addSources + 1} gt=${gv.nSources}`);
    }
  }
}

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const pages = [];
  for (let i = 0; i < CONC; i++) pages.push(await browser.newPage());
  // round-robin 분배
  const buckets = Array.from({ length: CONC }, () => []);
  slice.forEach((ing, i) => buckets[i % CONC].push(ing));
  await Promise.all(pages.map((p, i) => worker(p, buckets[i], i)));
  await browser.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n=== UI 대량 대조 === 성분 ${checkedIng} · 셀(국가규제) ${checkedCells} · skip(fuzzy) ${skipped} · ${secs}s`);
  console.log(`불일치: ${mismatches.length}`);
  mismatches.slice(0, 60).forEach((m) => console.log("  ❌ " + m));
  if (mismatches.length > 60) console.log(`  ... +${mismatches.length - 60} more`);
  process.exit(mismatches.length ? 1 : 0);
})();
