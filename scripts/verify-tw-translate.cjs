// 정품검증 — TW 중국어 출처명이 라이브에서 한글로 렌더되는지(결정론 seed) 직접 확인.
const { chromium } = require("playwright");
const BASE = process.env.VERIFY_BASE || "https://tim10000-alt.github.io/cosmetics-reg/";
// MAP 으로 한글화돼야 하는 중국어 출처 원문(이 문자열들은 카드에 절대 안 보여야 함).
const CHINESE_SRC = [
  "化粧品禁止使用成分表", "化粧品防腐劑成分使用限制表", "化粧品色素成分使用限制表",
  "化粧品成分使用限制表", "化粧品防曬劑成分使用限制表", "化粧品禁限用成分管理規定",
  "已使用化妆品原料目录",
];
const KO_SRC = /관리\s*규정/; // TW 출처명의 한글 핵심어(seed·Gemini 캐시 둘 다 포함)

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const fails = [];
  const ok = (c, m) => { console.log((c ? "✓" : "✗") + " " + m); if (!c) fails.push(m); };

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const input = page.locator('input[aria-label="화장품 원료 검색"]');
  await input.waitFor({ timeout: 30000 });
  await input.click(); await input.fill("Mercury"); await page.keyboard.press("Enter");
  await page.locator("details[data-country-card]").first().waitFor({ timeout: 120000 });
  await page.waitForTimeout(1000);

  const tw = page.locator("details[data-country-card]").filter({ has: page.locator(':scope > summary:has-text("대만")') }).first();
  ok(await tw.count() > 0, "대만 카드 존재");
  await tw.locator(":scope > summary").click();
  await page.waitForTimeout(400);
  const txt = await tw.innerText();

  // 1) 중국어 출처 원문이 카드 어디에도 안 보여야(MAP seed 로 전부 한글화)
  const leaked = CHINESE_SRC.filter((s) => txt.includes(s));
  ok(leaked.length === 0, `중국어 출처 원문 미노출 (누출: ${leaked.join(", ") || "없음"})`);
  // 2) 출처가 한글로 표기(seed MAP 또는 Gemini 캐시)
  ok(KO_SRC.test(txt), `한글 출처(관리 규정) 표기`);
  // 3) 상태 배지 한글
  ok(/배합금지/.test(txt), "상태 '배합금지' 표기");

  // 참고(정보): 조건문에 남은 중국어 = 파이프라인 누적 대상(잔여)
  const condCJK = (txt.match(/[㐀-鿿]/g) || []).length;
  console.log(`ℹ 카드 내 잔존 한자 ${condCJK}자 (조건문 — 번역 파이프라인 누적 처리 중)`);

  console.log(`\n결과: ${fails.length === 0 ? "PASS" : "FAIL " + fails.length}`);
  await browser.close();
  process.exit(fails.length === 0 ? 0 : 1);
})();
