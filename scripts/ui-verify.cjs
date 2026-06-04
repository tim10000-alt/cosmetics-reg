#!/usr/bin/env node
// 정품검증: 실제 렌더 UI 전수 확인. ?q= 딥링크로 lookupRegulation→CountryCard 렌더 경로 구동.
const { chromium } = require("playwright");

const NAME = {KR:"대한민국",US:"미국",TW:"대만",BR:"브라질",AR:"아르헨티나",CA:"캐나다",CN:"중국",EU:"유럽연합",JP:"일본",VN:"베트남",TH:"태국",ID:"인도네시아",MY:"말레이시아",PH:"필리핀",SG:"싱가포르",CO:"콜롬비아",EC:"에콰도르",PE:"페루",BO:"볼리비아"};

// 각 케이스: query, item(항목), 그리고 검사. country 카드 단위 또는 header 단위.
const CASES = [
  // ① MFDS KR numeric limits
  {item:"①KR한도", q:"Benzophenone-3", cc:"KR", expect:["배합한도","최대 배합한도:","5%"]},
  {item:"①KR한도", q:"Triethanolamine", cc:"KR", expect:["배합한도","2.5%"]},
  {item:"①KR한도", q:"Cocotrimonium Chloride", cc:"KR", expect:["0.1%"]},
  // ② comma corrected
  {item:"②쉼표", q:"Dihydroxyacetone", cc:"EU", expect:["배합한도","6.25%"], absent:["62.5","625"]},
  {item:"②쉼표", q:"HC Yellow No. 13", cc:"EU", expect:["배합한도","2.5%"], absent:["25%"]},
  {item:"②쉼표", q:"2-Methyl-5-Hydroxyethylaminophenol", cc:"EU", expect:["1.5%"], absent:["15%"]},
  // ③ JP Cysteamine 8.63
  {item:"③JP시스테아민", q:"Cysteamine Hydrochloride", cc:"JP", expect:["배합한도","8.63","g/100g"]},
  // ④ TW / CA limits
  {item:"④TW/CA", q:"Phenylbenzimidazole Sulfonic Acid", cc:"TW", expect:["배합한도","8%"]},
  {item:"④TW/CA", q:"Phenylbenzimidazole Sulfonic Acid", cc:"CA", expect:["배합한도","4%"]},
  {item:"④TW/CA", q:"Oxyquinoline", cc:"CA", expect:["배합한도","0.3%"]},
  {item:"④TW/CA", q:"Benzophenone-3", cc:"CA", expect:["배합한도","6%"]},
  // ⑤ US color entity decode (검색이 매칭됨 자체가 디코드 증거 + header 표기)
  {item:"⑤US색소디코드", q:"D&C Red No. 34", cc:"US", expect:["수록"], header:["D&C Red No. 34"], headerAbsent:["&amp;","&#"]},
  {item:"⑤US색소디코드", q:"FD&C Yellow No. 5", cc:"US", expect:["수록"], header:["FD&C Yellow No. 5"], headerAbsent:["&amp;","&#"]},
  {item:"⑤US색소디코드", q:"D&C Green No. 8", cc:"US", header:["D&C Green No. 8"], headerAbsent:["&amp;","&#"]},
  // ⑥ recovered names (RTL / JP matrix) — 클린 표기 + 규제 표시
  {item:"⑥복구명", q:"Cantharidine", cc:"EU", expect:["배합금지"], header:["Cantharidine"], headerAbsent:["カンタリス","○","42"]},
  {item:"⑥복구명", q:"N-Acetyl-L-Cysteine", header:["N-Acetyl-L-Cysteine"], headerAbsent:["システイン","○","4.0"]},
  {item:"⑥복구명", q:"Benzalkonium Chloride", header:["Benzalkonium Chloride"], headerAbsent:["○","42"]},
  // ⑦ quarantine garbage must NOT surface as a result header
  {item:"⑦격리숨김", q:"塩化ラウリルピリジニウム及び塩化ラウリルピリジニウム液を塩化ラウ", quarantineGarbage:true},
  {item:"⑦격리숨김", q:"ヤシ油脂肪酸ジエタノールアミド(2)42", quarantineGarbage:true},
];

function textHas(t, subs){ return subs.filter(s=>!t.includes(s)); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results = [];
  for (const c of CASES) {
    const url = "http://localhost:3010/?q=" + encodeURIComponent(c.q);
    let rec = {item:c.item, q:c.q, cc:c.cc||"", pass:true, notes:[]};
    try {
      await page.goto(url, {waitUntil:"domcontentloaded"});
      // wait until results render: an <article> appears OR not-found message
      await page.waitForFunction(() => {
        const a = document.querySelector("section article");
        const nf = Array.from(document.querySelectorAll("div")).some(d=>d.textContent.includes("찾지 못했습니다"));
        return !!a || nf;
      }, {timeout:15000});

      const notFound = await page.evaluate(()=>Array.from(document.querySelectorAll("div")).some(d=>d.textContent.includes("찾지 못했습니다")));
      const headerText = await page.evaluate(()=>{ const h=document.querySelector("section.rounded-lg, section"); // ingredient header is first section after form
        const secs=document.querySelectorAll("main section"); return secs.length?secs[0].innerText:""; });
      const inciText = await page.evaluate(()=>{ const el=Array.from(document.querySelectorAll("div")).find(d=>d.previousElementSibling&&d.previousElementSibling.textContent.trim()==="INCI"); return el?el.innerText:""; });

      if (c.quarantineGarbage) {
        // garbage must not appear as the matched ingredient header
        if (notFound) { rec.notes.push("not-found(정상: 격리 미노출)"); }
        else {
          const inci = inciText||headerText;
          if (c.q.slice(0,12) && inci.includes(c.q.slice(0,12))) { rec.pass=false; rec.notes.push("FAIL: 격리 쓰레기명이 결과 header에 노출 -> "+inci.slice(0,40)); }
          else rec.notes.push("매칭 INCI='"+inci.slice(0,40)+"' (격리문자열 아님=정상)");
        }
        results.push(rec); continue;
      }

      if (notFound) { rec.pass=false; rec.notes.push("FAIL: 검색 결과 없음(원료 미발견)"); results.push(rec); continue; }

      // header checks
      if (c.header) { const miss=textHas(inciText||headerText, c.header); if(miss.length){rec.pass=false; rec.notes.push("FAIL header누락:"+miss.join("|")+" (실제 INCI='"+(inciText||headerText).slice(0,50)+"')");} else rec.notes.push("header OK:'"+(inciText).slice(0,40)+"'"); }
      if (c.headerAbsent) { const bad=c.headerAbsent.filter(s=>(inciText||headerText).includes(s)); if(bad.length){rec.pass=false; rec.notes.push("FAIL header오염:"+bad.join("|"));} }

      // country card check
      if (c.cc) {
        const cardText = await page.evaluate((name)=>{
          const arts=Array.from(document.querySelectorAll("section article"));
          const card=arts.find(a=>a.innerText.includes(name));
          return card?card.innerText:null;
        }, NAME[c.cc]);
        if (!cardText) { rec.pass=false; rec.notes.push("FAIL: "+c.cc+" 카드 없음"); }
        else {
          if (c.expect) { const miss=textHas(cardText, c.expect); if(miss.length){rec.pass=false; rec.notes.push("FAIL expect누락:"+miss.join("|"));} }
          if (c.absent) { const bad=c.absent.filter(s=>cardText.includes(s)); if(bad.length){rec.pass=false; rec.notes.push("FAIL오염값:"+bad.join("|"));} }
          if (rec.pass) rec.notes.push("card OK: "+cardText.replace(/\n+/g," ").slice(0,90));
        }
      }
    } catch(e) {
      rec.pass=false; rec.notes.push("ERROR: "+e.message.slice(0,80));
    }
    results.push(rec);
  }
  await browser.close();

  let fail=0;
  for (const r of results) {
    const tag = r.pass?"✅":"❌"; if(!r.pass)fail++;
    console.log(`${tag} [${r.item}] q="${r.q}"${r.cc?" @"+r.cc:""}`);
    for (const n of r.notes) console.log("      "+n);
  }
  console.log(`\n=== ${results.length-fail}/${results.length} PASS, ${fail} FAIL ===`);
  process.exit(fail?1:0);
})();
