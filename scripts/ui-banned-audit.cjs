// 78 banned(veto/claude-judge-banned/authoritative-ban) 전수 UI 검증 — 진짜금지가 UI 에서
// 잘못 restricted/허용으로 뜨지 않는지(=규제사고 방지). 헤드라인이 banned 또는(상위출처가
// listed 인 경우) 상충배지로 금지가 표면화돼야 안전. 잘못 "배합한도/허용"만 뜨면 FAIL.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const D = path.join(__dirname, "..", "public", "data");
const J = (f) => JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));
const BASE = process.env.UI_BASE || "http://localhost:3011";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ing = J("ingredients.json").rows; const byId = new Map(ing.map((i) => [i.id, i]));
const CNAME = new Map(J("countries.json").rows.map((c) => [c.code, c.name_ko]));
const dec = J("status-decisions.json").decisions;
const banned = Object.entries(dec).filter(([, x]) => x.verdict === "banned" && (x.by === "prohibition-veto" || x.by === "claude-judge" || x.by === "authoritative-ban"));
const cas = (ig) => (String(ig.cas_no || "").match(/\d{2,7}-\d{2}-\d/) || [])[0];
let SAFE = 0, FAIL = 0, UNR = 0; const fails = [];
async function card(page, q, cn) {
  try { await page.goto(BASE + "/?q=" + encodeURIComponent(q), { waitUntil: "domcontentloaded", timeout: 10000 }); } catch { return null; }
  await page.waitForFunction(() => document.querySelectorAll("article").length > 0 || /찾지 못/.test(document.body.innerText), { timeout: 6000 }).catch(() => {});
  await sleep(150);
  return await page.evaluate((c) => {
    const a = [...document.querySelectorAll("article")].find((x) => x.querySelector("header") && x.querySelector("header").textContent.includes(c));
    if (!a) return { miss: true };
    const L = ["배합금지", "배합한도", "허용", "수록 (수출 가능)", "미수록 (수출 불가)"];
    let badge = ""; for (const sp of a.querySelectorAll("span")) { const t = sp.textContent.trim(); if (L.includes(t)) { badge = t; break; } }
    const banSurfaced = /배합금지|금지/.test(a.textContent);
    return { badge, banSurfaced };
  }, cn);
}
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage();
  console.log(`78 banned 전수 UI — ${banned.length}건`);
  for (let i = 0; i < banned.length; i++) {
    const [k, x] = banned[i]; const [id, ccode] = k.split(":"); const ig = byId.get(id);
    if (!ig || !ig.inci_name) { UNR++; continue; }
    const cn = CNAME.get(ccode) || ccode;
    let r = await card(page, ig.inci_name, cn);
    if ((!r || r.miss) && ig.korean_name) r = await card(page, ig.korean_name, cn);
    if ((!r || r.miss) && cas(ig)) r = await card(page, cas(ig), cn);
    if (!r || r.miss) { UNR++; continue; }
    // 안전 = 헤드라인 배합금지 OR (헤드라인 listed/허용이지만 금지가 본문/배지에 표면화)
    if (r.badge === "배합금지") SAFE++;
    else if (r.banSurfaced) SAFE++;   // listed 헤드라인이어도 금지 표면화됨
    else { FAIL++; fails.push(`${ig.inci_name} [${ccode}] → ${r.badge} (금지 미표면화!)`); }
    if ((i + 1) % 20 === 0) console.log(`  …진행 ${i + 1}/${banned.length} (안전 ${SAFE} FAIL ${FAIL} 미도달 ${UNR})`);
  }
  await browser.close();
  console.log(`\n결과: 금지안전(배합금지 or 표면화) ${SAFE} · 금지미표면화 ${FAIL} · 미도달 ${UNR}`);
  if (FAIL) console.log(fails.join("\n"));
  console.log("AUDIT_DONE");
})();
