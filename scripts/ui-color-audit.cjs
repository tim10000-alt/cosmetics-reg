#!/usr/bin/env node
// 색소(병합 타깃 + status 재분류) 전수 UI 표기 검증 — 각 affected ingredient 를 실제 렌더 구동해
// 국가카드별 모든 표기값(status pill·출처 링크 href·조건문)을 effective 데이터와 1:1 대조.
//
// 🛡 검증 신뢰성 가드(2026-06-08, 사용자 지적 "검증이 fragile 한 도구 위에 있으면 안 됨"):
//   ① serve 헬스를 시작+주기적으로 확인 — 죽었으면 조용히 헛돌지 말고 즉시 ABORT(거짓 "통과" 방지).
//   ② 진행상황을 sidecar 파일에 fs 동기 기록(stdout 블록버퍼링으로 "멈춘 듯" 보이는 불투명성 제거).
//   ⚠ 반드시 robust 서버로: `node scripts/serve-local.cjs` (npx serve 는 부하 크래시 이력).
// 사용: node scripts/ui-color-audit.cjs   (UI_BASE 기본 http://localhost:3010)
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const G = require(path.join(__dirname, "verify-groundtruth.cjs"));
const { byId, bucketFor, siblingIds, countries } = G;
const BASE = process.env.UI_BASE || "http://localhost:3010";
const PROGRESS = path.join(require("os").tmpdir(), "ui-color-audit.progress");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LABEL = { banned: "배합금지", restricted: "배합한도", allowed: "허용", listed: "수록 (수출 가능)", unknown: null };
const cMap = new Map(countries.map((c) => [c.code, c.name_ko || c.code]));
function prog(msg) { try { fs.appendFileSync(PROGRESS, msg + "\n"); } catch {} console.log(msg); }

// serve 헬스 — 죽으면 false(호출자가 abort). 검증이 죽은 서버 위에서 헛도는 것 방지.
function serveHealthy() {
  return new Promise((resolve) => {
    const req = http.get(BASE + "/", { timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// affected = (a) US 21CFR 색소 reg 보유 ingredient + (b) claude-color status override 대상
function affectedIds() {
  const D = path.join(__dirname, "..", "public", "data");
  const us = JSON.parse(fs.readFileSync(path.join(D, "regulations", "US.json"), "utf8")).rows;
  const ids = new Set();
  for (const r of us) if (/21 CFR 7[34]/.test(r.source_document || "")) ids.add(r.ingredient_id);
  const ov = JSON.parse(fs.readFileSync(path.join(D, "status-overrides.json"), "utf8")).corrections;
  for (const c of ov) if (/claude-color/.test(c.reason || "")) ids.add(c.ingredient_id);
  return [...ids].filter((id) => byId.get(id));
}

async function goto(page, q) {
  for (let t = 0; t < 2; t++) { try { await page.goto(BASE + "/?q=" + encodeURIComponent(q), { waitUntil: "domcontentloaded", timeout: 12000 }); break; } catch { await sleep(700); } }
  await page.waitForFunction(() => document.querySelectorAll("article").length > 0 || /찾을 수 없|결과가 없/.test(document.body.innerText), { timeout: 6000 }).catch(() => {});
  await sleep(250);
}
async function extract(page) {
  return await page.evaluate(() => {
    const labels = ["배합금지", "배합한도", "허용", "수록 (수출 가능)", "미수록 (수출 불가)"];
    const out = {};
    for (const art of document.querySelectorAll("article")) {
      const head = art.querySelector("header"); if (!head) continue;
      const cn = head.textContent.replace(/🤖.*$/, "").trim();
      let pill = null;
      for (const el of art.querySelectorAll("span.inline-block.rounded-md")) { const t = el.textContent.trim(); if (labels.includes(t)) { pill = t; break; } }
      out[cn] = { pill, links: [...art.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")), text: art.textContent };
    }
    return out;
  });
}

(async () => {
  try { fs.writeFileSync(PROGRESS, ""); } catch {}
  if (!(await serveHealthy())) { console.error(`🔴 ABORT: serve ${BASE} 응답 없음(HTTP≠200). robust 서버 먼저: node scripts/serve-local.cjs`); process.exit(2); }
  const ids = affectedIds();
  prog(`색소 affected ${ids.length} UI 전수 시작 (serve OK)`);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let PASS = 0, statusFAIL = 0, linkFAIL = 0, condFAIL = 0, unreached = 0, done = 0;
  const fails = [];
  for (const id of ids) {
    // 🛡 주기적 serve 헬스 — 죽었으면 즉시 중단(거짓 통과 방지)
    if (done % 25 === 0 && !(await serveHealthy())) { console.error(`🔴 ABORT @${done}/${ids.length}: serve 중단 감지 — 검증 무효. 재시작 후 재실행.`); await browser.close(); process.exit(2); }
    const ig = byId.get(id);
    const sibs = siblingIds.get(id) ?? new Set([id]);
    const expect = {};
    for (const c of countries) { const b = bucketFor(sibs, c.code); if (b && b.length) expect[c.code] = { status: b[0].status, row: b[0], all: b }; }
    if (!Object.keys(expect).length) { done++; continue; }
    let got = null;
    for (const q of [ig.inci_name, ig.korean_name, (ig.cas_no || "").match(/\d{2,7}-\d{2}-\d/)?.[0]].filter(Boolean)) {
      await goto(page, q); const ex = await extract(page); if (Object.keys(ex).length) { got = ex; break; }
    }
    done++;
    if (!got) { unreached++; fails.push(`UNREACHED ${ig.inci_name?.slice(0, 40)}`); continue; }
    const byCC = {};
    for (const [cn, v] of Object.entries(got)) { const code = [...cMap].find(([cc, n]) => cn.includes(n))?.[0]; if (code) byCC[code] = v; }
    for (const [cc, e] of Object.entries(expect)) {
      const rendered = byCC[cc]; const expLabel = LABEL[e.status];
      if (!rendered) { if (expLabel) { statusFAIL++; fails.push(`${ig.inci_name?.slice(0, 28)} [${cc}] CARD MISSING (expect ${expLabel})`); } continue; }
      if (expLabel && rendered.pill !== expLabel) { statusFAIL++; fails.push(`${ig.inci_name?.slice(0, 28)} [${cc}] status rendered="${rendered.pill}" expect="${expLabel}"`); }
      const headUrl = e.row.source_url;
      if (headUrl && !rendered.links.includes(headUrl)) { linkFAIL++; fails.push(`${ig.inci_name?.slice(0, 28)} [${cc}] head source link 누락`); }
      const cond = (e.row.conditions || "").replace(/\s+/g, " ").trim();
      if (cond && cond.length > 8 && !rendered.text.replace(/\s+/g, " ").includes(cond.slice(0, 14))) { condFAIL++; fails.push(`${ig.inci_name?.slice(0, 26)} [${cc}] 조건문 누락 "${cond.slice(0, 14)}"`); }
      PASS++;
    }
    if (done % 30 === 0) prog(`  …${done}/${ids.length} (PASS ${PASS} statusFAIL ${statusFAIL} linkFAIL ${linkFAIL} condFAIL ${condFAIL} unreached ${unreached})`);
  }
  await browser.close();
  prog(`\n=== 색소 affected ${ids.length} UI 전수 ===`);
  prog(`cell PASS ${PASS} · statusFAIL ${statusFAIL} · linkFAIL ${linkFAIL} · condFAIL ${condFAIL} · unreached ${unreached}`);
  fails.slice(0, 60).forEach((x) => prog("  " + x));
  process.exit(statusFAIL + linkFAIL + condFAIL + unreached > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
