// PWA 아이콘 생성기 — SVG 를 Playwright(chromium)로 PNG 래스터화.
// 이미 devDeps 에 있는 playwright 만 사용(추가 의존 0). 생성물: public/icons/*.png + public/favicon 보조.
//
//   node scripts/make-icons.cjs
//
// glyph: 돋보기(검색) + 물방울(원료) — 다크 네이비 배경. maskable 은 안전영역(중앙 80%) 안에 glyph.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUT = path.join(__dirname, "..", "public", "icons");

// pad: 0 = full-bleed glyph(any), 0.16 = maskable 안전영역 여백.
// viewBox 512 기준. 배경은 항상 full-bleed(둥근 사각 or 사각), glyph 만 pad 적용.
function svg({ pad = 0, rounded = true } = {}) {
  const S = 512;
  const r = rounded ? 96 : 0;
  // glyph 영역: pad 비율만큼 안쪽으로. 기본 glyph box 는 96..416(=320) 을 pad 로 축소.
  const inset = pad * S;
  const gx = 96 + inset * 0.5;
  const gSize = 320 - inset;
  const cx = gx + gSize * 0.42;
  const cy = gx + gSize * 0.42;
  const lens = gSize * 0.30; // 렌즈 반지름
  const hw = gSize * 0.10;   // 손잡이 두께
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#111a3a"/>
      <stop offset="1" stop-color="#0b1020"/>
    </linearGradient>
    <linearGradient id="drop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" rx="${r}" ry="${r}" fill="url(#bg)"/>
  <!-- 돋보기 손잡이 -->
  <line x1="${cx + lens * 0.72}" y1="${cy + lens * 0.72}" x2="${gx + gSize - hw * 0.4}" y2="${gx + gSize - hw * 0.4}"
        stroke="#e0e7ff" stroke-width="${hw}" stroke-linecap="round"/>
  <!-- 렌즈 링 -->
  <circle cx="${cx}" cy="${cy}" r="${lens}" fill="#0b1020" stroke="#e0e7ff" stroke-width="${hw * 0.9}"/>
  <!-- 렌즈 안 물방울 -->
  <path d="M ${cx} ${cy - lens * 0.55}
           C ${cx + lens * 0.62} ${cy + lens * 0.05}, ${cx + lens * 0.34} ${cy + lens * 0.62}, ${cx} ${cy + lens * 0.62}
           C ${cx - lens * 0.34} ${cy + lens * 0.62}, ${cx - lens * 0.62} ${cy + lens * 0.05}, ${cx} ${cy - lens * 0.55} Z"
        fill="url(#drop)"/>
</svg>`;
}

async function render(page, svgStr, size, file) {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0">${svgStr.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body>`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html, { waitUntil: "networkidle" });
  const el = await page.$("svg");
  await el.screenshot({ path: file, omitBackground: true });
  console.log("wrote", path.relative(path.join(__dirname, ".."), file), `(${size}px)`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const any = svg({ pad: 0, rounded: true });
  const maskable = svg({ pad: 0.18, rounded: false }); // maskable: full-bleed 사각 + 안전영역 glyph
  await render(page, any, 192, path.join(OUT, "icon-192.png"));
  await render(page, any, 512, path.join(OUT, "icon-512.png"));
  await render(page, any, 180, path.join(OUT, "apple-touch-icon.png"));
  await render(page, maskable, 512, path.join(OUT, "icon-maskable-512.png"));
  await browser.close();
})();
