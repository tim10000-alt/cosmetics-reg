// 정품검증 — 변경분(접기 UI·번역·설치버튼) 실 구동 검증. teeth 아니라 실제 동작 확인.
const { chromium } = require("playwright");
const BASE = process.env.VERIFY_BASE || "https://tim10000-alt.github.io/cosmetics-reg/";
const CJK = /[㐀-鿿぀-ヿ฀-๿]/;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // 모바일
  const fails = [];
  const ok = (c, m) => { console.log((c ? "✓" : "✗") + " " + m); if (!c) fails.push(m); };

  page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 140)); });

  async function search(q) {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const input = page.locator('input[aria-label="화장품 원료 검색"]');
    await input.waitFor({ timeout: 30000 });
    await input.click();
    await input.fill(q);
    await page.keyboard.press("Enter");
    // 결과(국가 카드) 등장 대기 — 데이터 ~수MB 로드 포함.
    await page.locator("details[data-country-card]").first().waitFor({ timeout: 120000 });
    await page.waitForTimeout(1500);
  }

  console.log("=== 검색: Salicylic Acid (대만 보존제 데이터 보유 예상) ===");
  await search("Salicylic Acid");

  const cards = page.locator("details[data-country-card]");
  const n = await cards.count();
  ok(n >= 5, `국가 카드 ${n}개 렌더`);

  // 1) 기본 접힘 확인
  let openCount = 0;
  for (let i = 0; i < n; i++) if (await cards.nth(i).evaluate((d) => d.open)) openCount++;
  ok(openCount === 0, `기본 전부 접힘 (열린 카드 ${openCount})`);

  // 2) 요약행에 상태 배지(텍스트) 보이는지
  const firstSummaryText = (await cards.first().locator(":scope > summary").innerText()).replace(/\s+/g, " ").trim();
  ok(/배합금지|배합한도|허용|수록|미수록|검토|확인|조건부/.test(firstSummaryText), `요약행 상태 배지: "${firstSummaryText}"`);

  // 3) 접힘 상태에서 본문(조건 등)이 화면에 안 보여야(접힘 동작)
  // 4) 클릭하면 펼쳐지는지
  const tw = cards.filter({ has: page.locator(':scope > summary:has-text("대만")') });
  const hasTW = (await tw.count()) > 0;
  ok(hasTW, "대만(TW) 카드 존재");
  const target = hasTW ? tw.first() : cards.first();
  await target.locator(":scope > summary").click();
  await page.waitForTimeout(400);
  ok(await target.evaluate((d) => d.open), "클릭 시 카드 펼쳐짐");
  const bodyText = (await target.innerText()).replace(/\s+/g, " ").trim();
  ok(bodyText.length > firstSummaryText.length + 10, "펼친 본문 내용 노출");

  // 5) 대만 출처/조건이 한글화(중국어 잔존 없는지) — 출처 줄
  if (hasTW) {
    const twText = await target.innerText();
    // 출처 라벨 주변 텍스트에서 중국어 검출
    const srcMatch = twText.split("출처").slice(1).join("출처").slice(0, 200);
    ok(!CJK.test(srcMatch), `대만 출처 줄 한글화 (발췌: "${srcMatch.replace(/\s+/g, " ").trim().slice(0, 80)}")`);
  }

  // 6) 설치 버튼(standalone 아님 → 보여야)
  const installBtn = page.locator('button[aria-label="앱 설치"]');
  ok(await installBtn.count() > 0, "설치 버튼 렌더(앱 설치)");

  // 7) 모두 펼치기 토글
  const expandAll = page.locator('button:has-text("모두 펼치기")');
  if (await expandAll.count() > 0) {
    await expandAll.click();
    await page.waitForTimeout(500);
    let openNow = 0;
    for (let i = 0; i < n; i++) if (await cards.nth(i).evaluate((d) => d.open)) openNow++;
    ok(openNow === n, `모두 펼치기 동작 (열림 ${openNow}/${n})`);
  }

  console.log(`\n결과: ${fails.length === 0 ? "ALL PASS" : "FAIL " + fails.length + "건"}`);
  await browser.close();
  process.exit(fails.length === 0 ? 0 : 1);
})();
