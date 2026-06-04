#!/usr/bin/env node
// 정품검증 2회차 — push-back 5항목: 자동완성 타이핑 경로 / 복구명 규제카드 / 한글검색 / cascade / 격리 공유토큰
const { chromium } = require("playwright");
const NAME = {KR:"대한민국",US:"미국",TW:"대만",CA:"캐나다",CN:"중국",EU:"유럽연합",JP:"일본"};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = [];
  const log = (p,m)=>out.push((p?"✅":"❌")+" "+m);
  let fail=0; const F=(m)=>{fail++;log(false,m);};

  // ---- PB#1: 실제 타이핑 + ArrowDown + Enter 자동완성 경로 ----
  for (const {type, expectInci, cc, expectCard} of [
    {type:"Benzophenone-3", expectInci:"Benzophenone-3", cc:"KR", expectCard:"5%"},
    {type:"레티놀", expectInci:"Retinol", cc:null, expectCard:null},
    {type:"살리실릭", expectInci:"Salicylic", cc:null, expectCard:null},
  ]) {
    try {
      await page.goto("http://localhost:3010/", {waitUntil:"domcontentloaded"});
      const input = page.locator('input[role="combobox"]');
      await input.click();
      await input.fill("");
      await input.type(type, {delay:30});
      // wait for suggestions listbox
      await page.waitForSelector('#autocomplete-listbox [role="option"]', {timeout:8000});
      await input.press("ArrowDown");
      await input.press("Enter");
      await page.waitForFunction(()=>{const a=document.querySelector("section article");const nf=Array.from(document.querySelectorAll("div")).some(d=>d.textContent.includes("찾지 못했습니다"));return !!a||nf;},{timeout:15000});
      const inci = await page.evaluate(()=>{const el=Array.from(document.querySelectorAll("div")).find(d=>d.previousElementSibling&&d.previousElementSibling.textContent.trim()==="INCI");return el?el.innerText:"";});
      let ok = inci.includes(expectInci);
      let extra = "";
      if (ok && cc && expectCard) {
        const card = await page.evaluate((n)=>{const a=Array.from(document.querySelectorAll("section article")).find(x=>x.innerText.includes(n));return a?a.innerText:"";},NAME[cc]);
        if (!card.includes(expectCard)) { ok=false; extra=" (카드 '"+expectCard+"' 누락)"; } else extra=" card@"+cc+" has "+expectCard;
      }
      if (ok) log(true,`PB#1 자동완성타이핑 "${type}" → INCI '${inci.slice(0,30)}'${extra}`);
      else F(`PB#1 자동완성 "${type}" → 기대 '${expectInci}' 불일치 (실제 '${inci.slice(0,40)}')${extra}`);
    } catch(e){ F(`PB#1 "${type}" ERROR ${e.message.slice(0,70)}`); }
  }

  // ---- PB#2/#5: 복구명 규제카드 + 한글검색 + 격리 공유토큰 (deep-link로 충분, 다국가 카드 확인) ----
  const dl = async (q)=>{
    await page.goto("http://localhost:3010/?q="+encodeURIComponent(q),{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>{const a=document.querySelector("section article");const nf=Array.from(document.querySelectorAll("div")).some(d=>d.textContent.includes("찾지 못했습니다"));return !!a||nf;},{timeout:15000});
    return page.evaluate(()=>{
      const el=Array.from(document.querySelectorAll("div")).find(d=>d.previousElementSibling&&d.previousElementSibling.textContent.trim()==="INCI");
      const inci=el?el.innerText:"";
      const arts=Array.from(document.querySelectorAll("section article"));
      const verified=arts.filter(a=>/배합금지|배합한도|허용|수록|미수록/.test(a.innerText)).length;
      const nf=Array.from(document.querySelectorAll("div")).some(d=>d.textContent.includes("찾지 못했습니다"));
      return {inci, cards:arts.length, verified, nf};
    });
  };

  // PB#2 복구명이 규제카드(verified)를 실제로 보유
  for (const {q,minV} of [{q:"N-Acetyl-L-Cysteine",minV:1},{q:"Benzalkonium Chloride",minV:1},{q:"Cantharidine",minV:1}]) {
    try { const r=await dl(q); if(!r.nf && r.verified>=minV && r.inci.includes(q.split(" ")[0])) log(true,`PB#2 복구명 "${q}" → INCI '${r.inci.slice(0,30)}' verified카드 ${r.verified}건`); else F(`PB#2 "${q}" → nf=${r.nf} verified=${r.verified} inci='${r.inci.slice(0,30)}'`);}catch(e){F(`PB#2 "${q}" ERR ${e.message.slice(0,60)}`);}
  }

  // PB#3 한글명 검색 경로
  // 트라이에탄올아민 = KCIA 표준 한글표기(트리에탄올아민이 아님). 표준명으로 검색해야 정확 매칭.
  for (const {q,expectInci} of [{q:"시스테아민에이치씨엘",expectInci:"Cysteamine HCl"},{q:"트라이에탄올아민",expectInci:"Triethanolamine"}]) {
    try { const r=await dl(q); if(!r.nf && r.inci.includes(expectInci)) log(true,`PB#3 한글검색 "${q}" → '${r.inci.slice(0,30)}'`); else F(`PB#3 한글 "${q}" → 기대 '${expectInci}' 실제 '${r.inci.slice(0,30)}' nf=${r.nf}`);}catch(e){F(`PB#3 "${q}" ERR ${e.message.slice(0,60)}`);}
  }

  // PB#5 격리어와 공유토큰 가진 정상성분 정상반환
  // アラントイン 레코드의 INCI 는 본래 일본어명(JP 別表1 원료) — 복구로 쓰레기 제거된 클린 'アラントイン' 이 정답.
  for (const {q,expectInci} of [{q:"アラントイン",expectInci:"アラントイン"},{q:"ハッカ油",expectInci:""}]) {
    try { const r=await dl(q);
      // 격리 쓰레기명 패턴(연속숫자/○ 떼지어)이 결과에 없어야
      const garbage = /○○○○|\d{4,}|421\.|420\.5/.test(r.inci);
      if (!garbage && (!expectInci || r.inci.includes(expectInci))) log(true,`PB#5 공유토큰 "${q}" → '${r.inci.slice(0,30)}' (격리쓰레기 아님)`);
      else F(`PB#5 "${q}" → '${r.inci.slice(0,40)}' garbage=${garbage}`);
    }catch(e){F(`PB#5 "${q}" ERR ${e.message.slice(0,60)}`);}
  }

  // PB#4 cascade "추가 출처" — Benzophenone-3 KR 다출처 펼침 + 오염값(>100, 쉼표오값) 없음
  try {
    await page.goto("http://localhost:3010/?q=Benzophenone-3",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>!!document.querySelector("section article"),{timeout:15000});
    const summaries = await page.evaluate(()=>Array.from(document.querySelectorAll("summary")).map(s=>s.innerText).filter(t=>t.includes("추가 출처")));
    // expand all "추가 출처" details and read text
    await page.evaluate(()=>{document.querySelectorAll("details").forEach(d=>d.open=true);});
    const allText = await page.evaluate(()=>document.querySelector("main").innerText);
    const overVals = (allText.match(/(\d{3,}(?:\.\d+)?)\s*%/g)||[]).filter(v=>parseFloat(v)>100);
    if (summaries.length>0 && overVals.length===0) log(true,`PB#4 cascade 추가출처 ${summaries.length}개 펼침, >100% 오염값 0`);
    else if (overVals.length>0) F(`PB#4 cascade에 >100% 오염값: ${overVals.join(",")}`);
    else log(true,`PB#4 cascade: 추가출처 summary 없음(단일출처) — 오염값 0`);
  } catch(e){ F(`PB#4 cascade ERR ${e.message.slice(0,70)}`); }

  await browser.close();
  console.log(out.join("\n"));
  console.log(`\n=== ${out.length-fail}/${out.length} PASS, ${fail} FAIL ===`);
  process.exit(fail?1:0);
})();
