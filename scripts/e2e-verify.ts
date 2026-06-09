import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { loadEnv } from "./crawlers/env";
loadEnv();
import { readRows } from "../lib/json-store";

interface QuarRow { ingredient_name_raw: string | null; country_code: string | null; status?: string }
interface IngRow { id: string; inci_name: string }
interface RegRow { ingredient_id: string; country_code: string }

// BASE는 E2E_BASE 환경변수 또는 *로컬 정적 서버 기본값*. 이 프로젝트는 100% 로컬 모드(Phase 5b)이고
// Netlify 는 미사용 결정(2026-06)되어, 기본값을 localhost:3010 으로 둠 — 과거 기본이 stale 한 netlify
// prod URL 이라 E2E_BASE 미설정 수동 실행이 죽은 사이트를 검증하던 footgun 제거. 외부 호스트 스모크가
// 필요하면 E2E_BASE=https://… 로 명시. (pr-check.yml 은 이미 E2E_BASE=http://localhost:3010 설정.)
const BASE = process.env.E2E_BASE ?? "http://localhost:3010";
const SHOT_DIR = ".e2e-shots";
// Static export 후엔 /api/* 와 middleware 가 없음. 헤더 검증은 호스팅 레이어 몫.
// localhost 정적 서버(npx serve)는 보안 헤더를 부여하지 않으므로 prod 호스트일 때만 확인.
const IS_PROD_HOST = BASE.startsWith("https://");

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}  ${detail}`);
}

async function search(page: Page, q: string) {
  await page.fill('input[type="text"]', "");
  await page.fill('input[type="text"]', q);
  await page.keyboard.press("Enter");
  await page
    .locator("article")
    .first()
    .or(page.locator("text=DB에서 찾지 못했습니다"))
    .waitFor({ timeout: 15_000 });
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });

  // pending 상태 테스트: quarantine 에 있고 regulations 에 없는 (ingredient, country) 조합.
  // 모든 데이터는 public/data/*.json (Phase 5b — Supabase 의존 0).
  async function findPendingOnly(): Promise<string> {
    const quars = await readRows<QuarRow>("quarantine");
    const ings = await readRows<IngRow>("ingredients");
    const regs = await readRows<RegRow>("regulations");
    const ingByLower = new Map<string, IngRow>();
    for (const i of ings) ingByLower.set(i.inci_name.toLowerCase(), i);
    const regKey = new Set<string>();
    for (const r of regs) regKey.add(`${r.ingredient_id}::${r.country_code}`);
    for (const q of quars) {
      if (!q.ingredient_name_raw || !q.country_code) continue;
      if (q.status && q.status !== "pending") continue;
      // 너무 긴 INCI (괄호 안 부가설명 등) 는 사용자가 실제 검색하지 않음 — skip
      if (q.ingredient_name_raw.length > 50) continue;
      const ing = ingByLower.get(q.ingredient_name_raw.toLowerCase());
      if (!ing) continue;
      if (!regKey.has(`${ing.id}::${q.country_code}`)) return q.ingredient_name_raw;
    }
    return "";
  }
  const pendingName = await findPendingOnly();
  console.log(`[setup] pending-only 원료: ${pendingName || "(없음 — T15 skip)"}`);

  // --no-sandbox: CI 의 Playwright 컨테이너는 root 로 실행되어 Chromium sandbox 가 거부됨(로컬 비-root
  // 에선 무해). --disable-dev-shm-usage: 컨테이너의 작은 /dev/shm 으로 인한 크래시 방지.
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // ========== Desktop 시나리오 ==========
  const ctx = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url()}`); });

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 });
  const title = await page.title();
  record("T1 홈 로드", title.includes("화장품"), `title="${title}"`);

  await search(page, "Retinol");
  const cards = await page.locator("article").count();
  record("T2 Retinol 19개 카드", cards === 19, `rendered ${cards}`);

  const cnHtml = await page.locator("article", { hasText: "중국" }).first().innerHTML();
  // Retinol 이 IECIC 등재 확인됨 (NMPA 1차 데이터) — listed 상태 표시 정상.
  // 미등재 ingredient 의 빨강 경고 분기는 별도 시나리오 (T3b) 에서 검증.
  record("T3 CN IECIC 등재 표시",
    /listed|수록|IECIC/.test(cnHtml) && !/DB에서 찾지 못했습니다/.test(cnHtml),
    `cn card present`);

  const twHtml = await page.locator("article", { hasText: "대만" }).first().innerHTML();
  record("T4 TW 빨강+Positive",
    /bg-red-100|text-red-8/.test(twHtml) && /Positive List|등록 여부 확인/.test(twHtml),
    `red+positive`);

  const jpHtml = await page.locator("article", { hasText: "일본" }).first().innerHTML();
  record("T5 JP 노랑+Annex",
    /bg-amber-100|text-amber-8/.test(jpHtml) && /Annex|조건부 허용/.test(jpHtml),
    `amber+annex`);

  const caHtml = await page.locator("article", { hasText: "캐나다" }).first().innerHTML();
  record("T6 CA verified", /자동 업데이트|배합한도|Maximum/.test(caHtml), `verified`);

  await search(page, "Benzophenone-4");
  const hdr = await page.locator("section").first().innerHTML();
  record("T7 function 배지+desc",
    /bg-sky-100|자외선차단제/.test(hdr) && /자외선으로부터/.test(hdr),
    `sky+desc`);

  // T8 autocomplete: 레티
  await page.fill('input[type="text"]', "");
  await page.type('input[type="text"]', "레티", { delay: 60 });
  await page.waitForTimeout(500);
  // 자동완성 드롭다운만 정확히 타겟(role=listbox) — 결과영역의 다른 ul(다중결과·related_variants)
  // 과 구분. "ul.first()" 는 직전 결과의 다중결과 목록을 잡아 오탐했음.
  const drop = page.locator('ul[role="listbox"]');
  const dropItems = await drop.locator("li").count().catch(() => 0);
  record("T8 autocomplete 레티", dropItems > 0, `items=${dropItems}`);

  // T9 빈 입력 → 드롭다운 숨김 (F-10 수정의 런타임 검증)
  await page.fill('input[type="text"]', "");
  await page.waitForTimeout(300);
  const emptyVis = await drop.isVisible().catch(() => false);
  record("T9 빈 입력 드롭다운 숨김", !emptyVis, `visible=${emptyVis}`);

  // T10 없는 원료
  await search(page, "ZZZNonExistentIngredient");
  const body10 = await page.textContent("body");
  record("T10 없는 원료 메시지", body10?.includes("DB에서 찾지 못했습니다") ?? false, ``);

  // T11 콘솔·5xx 무오류
  record("T11 콘솔/5xx 0건", errs.length === 0, `errs=${errs.length}`);

  // T12 한국어 검색 정확 매칭 (레티놀 → Retinol ingredient header 표시)
  await search(page, "레티놀");
  const header12 = await page.textContent("body");
  record("T12 한국어 검색", header12?.includes("Retinol") ?? false, `Retinol header`);

  // T13 CAS 검색
  await search(page, "68-26-8");
  const header13 = await page.textContent("body");
  record("T13 CAS 검색", header13?.includes("Retinol") ?? false, `Retinol header from CAS`);

  // T14 키보드 내비: 페이지 reload로 깨끗한 상태 → "레티" type → dropdown 렌더 대기 → ArrowDown → Enter
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 });
  await page.focus('input[type="text"]');
  await page.type('input[type="text"]', "레티", { delay: 80 });
  // 실제 드롭다운 li가 나타날 때까지 대기 (debounce 120ms + API + render)
  await page.locator("ul li").first().waitFor({ timeout: 5_000 });
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
  // 키워드 pick → runSearch → ingredient header 등장 대기 (INCI 텍스트 'Retino' 포함)
  await page.locator("text=/Retin/i").first().waitFor({ timeout: 15_000 });
  const after14 = await page.textContent("body");
  record("T14 키보드 내비 ArrowDown+Enter", !!after14 && /Retin/i.test(after14), `Retin header`);

  // T15 pending 상태 렌더 — fresh URL 딥링크로 진입해 이전 검색 잔재 회피
  if (pendingName) {
    await page.goto(`${BASE}/?q=${encodeURIComponent(pendingName)}`, { waitUntil: "networkidle", timeout: 30_000 });
    await page.locator("article").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    const pendingBadges = await page.locator("text=검토 중").count();
    await page.screenshot({ path: `${SHOT_DIR}/t15-pending.png`, fullPage: true });
    record(`T15 pending 렌더 (${pendingName.slice(0,30)})`,
      pendingBadges > 0,
      `"검토 중" 배지 ${pendingBadges}개`);
  } else {
    record("T15 pending 렌더", true, "skip — pending-only 원료 없음");
  }

  // T16 PostgREST injection 방어 (UI 경로) — "Retinol,cas_no.eq.X"
  await search(page, "Retinol,cas_no.eq.X");
  const body16 = await page.textContent("body");
  // injection 되면 전혀 다른 결과 또는 에러. sanitize 작동하면 "Retinol" 만으로 검색돼 결과 정상.
  record("T16 UI injection 방어", body16?.includes("Retinol") ?? false, `sanitized to Retinol`);

  // T19 URL 딥링크 — /?q=Retinol 로 직접 진입 시 자동 검색
  await page.goto(`${BASE}/?q=Retinol`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.locator("article").first().waitFor({ timeout: 15_000 });
  const urlT19 = page.url();
  const deepBody = await page.textContent("body");
  record("T19 URL 딥링크 /?q=Retinol",
    urlT19.includes("q=Retinol") && (deepBody?.includes("Retinol") ?? false),
    `url=${urlT19.includes("q=Retinol")} content=${deepBody?.includes("Retinol")}`);

  // T20 a11y attributes — combobox role + aria-expanded
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 });
  const role = await page.locator('input[role="combobox"]').count();
  const hasListbox = await page.locator('[role="listbox"]').count().catch(() => 0);
  // type 후 listbox 나타나는지
  await page.focus('input[role="combobox"]');
  await page.type('input[role="combobox"]', "레티", { delay: 60 });
  await page.locator('[role="listbox"] [role="option"]').first().waitFor({ timeout: 5_000 });
  const listboxVisible = await page.locator('[role="listbox"]').isVisible();
  const expanded = await page.locator('input[role="combobox"]').getAttribute("aria-expanded");
  record("T20 a11y combobox + listbox",
    role === 1 && listboxVisible && expanded === "true",
    `role=${role} listbox-visible=${listboxVisible} expanded=${expanded} (initial listbox=${hasListbox})`);

  // T21 /sources 데이터 상태 (Phase 5 — meta.json 기반 정적 카드)
  const srcRes = await page.goto(`${BASE}/sources`, { waitUntil: "networkidle", timeout: 30_000 });
  const srcStatus = srcRes?.status() ?? 0;
  await page.waitForTimeout(1500);
  const srcBody = await page.textContent("body");
  record("T21 /sources 데이터 상태",
    srcStatus === 200 && (srcBody?.includes("데이터 상태") ?? false) && (srcBody?.includes("ingredients") ?? false),
    `HTTP ${srcStatus} + counts 카드 렌더`);
  await page.screenshot({ path: `${SHOT_DIR}/t21-sources.png`, fullPage: true });

  // T22 — Static export 이후 middleware 제거. 정적 사이트엔 /api/* 자체가 없으므로 N/A.
  record("T22 rate limit (Static 모드 — middleware 제거)", true, "n/a");

  // T23/T24 보안 헤더는 호스팅 레이어 (Netlify _headers / netlify.toml) 몫.
  // localhost npx serve 는 헤더를 부여하지 않으므로 prod 호스트일 때만 검증.
  if (IS_PROD_HOST) {
    const secRes = await page.request.get(BASE);
    const secH = secRes.headers();
    const secOk = !!secH["x-content-type-options"] && !!secH["x-frame-options"] && !!secH["strict-transport-security"];
    record("T23 보안 헤더 5종", secOk,
      `XCTO=${!!secH["x-content-type-options"]} XFO=${!!secH["x-frame-options"]} HSTS=${!!secH["strict-transport-security"]}`);
    // Phase 5b — Supabase 제거됨. CSP connect-src 'self' (외부 connect 없음) 확인.
    const csp = secH["content-security-policy-report-only"];
    record("T24 CSP-Report-Only",
      !!csp && /connect-src\s+'self'/.test(csp) && csp.includes("default-src 'self'"),
      csp ? "self-only CSP OK" : "MISSING");
  } else {
    record("T23 보안 헤더 (host-layer only — localhost skip)", true, "n/a on npx serve");
    record("T24 CSP (host-layer only — localhost skip)", true, "n/a on npx serve");
  }

  // T25 robots.txt + sitemap
  const rob = await page.request.get(`${BASE}/robots.txt`);
  const sit = await page.request.get(`${BASE}/sitemap.xml`);
  record("T25 robots + sitemap",
    rob.status() === 200 && sit.status() === 200,
    `robots HTTP ${rob.status()} sitemap HTTP ${sit.status()}`);

  await page.screenshot({ path: `${SHOT_DIR}/desktop-final.png`, fullPage: true });
  await ctx.close();

  // ========== Mobile 시나리오 ==========
  const mctx = await browser.newContext({
    locale: "ko-KR",
    viewport: { width: 375, height: 667 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  const mpage = await mctx.newPage();
  await mpage.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 });
  await search(mpage, "Retinol");
  const mCards = await mpage.locator("article").count();
  record("T17 모바일 viewport 렌더", mCards === 19, `${mCards} cards at 375px`);
  await mpage.screenshot({ path: `${SHOT_DIR}/mobile-retinol.png`, fullPage: true });
  await mctx.close();

  // ========== 다크모드 시나리오 ==========
  const dctx = await browser.newContext({
    locale: "ko-KR",
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  });
  const dpage = await dctx.newPage();
  await dpage.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 });
  await search(dpage, "Retinol");
  // Tailwind dark: 클래스가 적용됐는지 확인 — body 배경 계산값 기준 (class 확인은 tailwind v4에선 미신뢰)
  const htmlClass = await dpage.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { bg: style.backgroundColor, color: style.color };
  });
  // tailwind dark:* 가 적용되면 body bg는 보통 zinc 계열 어두운 색. 체크: 배경 RGB 평균이 128 이하
  const m = htmlClass.bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  const avg = m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : 255;
  record("T18 다크모드 적용", avg < 128, `bg avg=${avg.toFixed(0)} (< 128 = dark)`);
  await dpage.screenshot({ path: `${SHOT_DIR}/dark-retinol.png`, fullPage: true });
  await dctx.close();

  await browser.close();

  const pass = results.filter(r => r.ok).length;
  console.log(`\n=== SUMMARY === ${pass}/${results.length} passed`);
  if (pass < results.length) {
    results.filter(r => !r.ok).forEach(r => console.log(`  FAIL: ${r.name} — ${r.detail}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
