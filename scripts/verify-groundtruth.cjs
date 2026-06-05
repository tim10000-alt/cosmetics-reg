#!/usr/bin/env node
// 정품검증용 ground-truth 산출기 — lib/regulations-query.ts + data-loader.ts 의 선택 로직을 포팅.
// UI 가 보여줘야 할 대표행(status·max_conc·unit·conditions·source)을 쿼리별로 계산.
const fs = require("fs");
const path = require("path");
const D = path.join(__dirname, "..", "public", "data");
const J = (f) => JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));

const ingAll = J("ingredients.json").rows;
const countries = J("countries.json").rows;
const quarNames = (() => { try { return J("quarantine-names.json").items.map((x) => x.id); } catch { return []; } })();
const quarSet = new Set(quarNames);
const ingredients = ingAll.filter((i) => !quarSet.has(i.id));

const regs = [];
for (const c of countries) {
  try { regs.push(...J(`regulations/${c.code}.json`).rows); } catch {}
}

// indices
const byInciLower = new Map(), byKorLower = new Map(), byCas = new Map(), byId = new Map();
for (const i of ingredients) {
  byId.set(i.id, i);
  if (i.inci_name) byInciLower.set(i.inci_name.toLowerCase(), i);
  if (i.korean_name) byKorLower.set(i.korean_name.toLowerCase(), i);
  if (i.cas_no) for (const cas of i.cas_no.split(/\s+/)) if (cas.trim()) byCas.set(cas.trim(), i);
}
const regsByIC = new Map();
for (const r of regs) {
  let inner = regsByIC.get(r.ingredient_id);
  if (!inner) { inner = new Map(); regsByIC.set(r.ingredient_id, inner); }
  let b = inner.get(r.country_code);
  if (!b) { b = []; inner.set(r.country_code, b); }
  b.push(r);
}

// sibling building (canonName / cas / synprefix) — ported
const GREEK = {"α":"alpha","β":"beta","γ":"gamma","δ":"delta","ε":"epsilon","ζ":"zeta","η":"eta","θ":"theta","ι":"iota","κ":"kappa","λ":"lambda","μ":"mu","ν":"nu","ξ":"xi","ο":"omicron","π":"pi","ρ":"rho","σ":"sigma","τ":"tau","υ":"upsilon","φ":"phi","χ":"chi","ψ":"psi","ω":"omega"};
const normKey = (s) => s.toLowerCase().replace(/[αβγδεζηθικλμνξοπρστυφχψω]/g,(m)=>GREEK[m]??m).replace(/[；;]/g,",").replace(/[（）]/g,(m)=>m==="（"?"(":")").replace(/\s*,\s*/g,",").replace(/\s+/g," ").trim();
const canonName = (s) => normKey(s).replace(/[,\s]*\(\s*cas\s*(?:no\.?)?\s*[\d\-,\s/]+\)/g,"").replace(/[,\s]+c\.?i\.?\s*\d{4,6}/g,"").replace(/[,\s]+$/,"").replace(/^[,\s]+/,"").trim();
const isValidCas = (c) => /^\d{1,7}-\d{2}-\d$/.test(c);
const casTokens = (raw) => raw.split(/\s+/).map((c)=>c.trim()).filter(isValidCas);
const isSynPrefix = (a,b) => { const sh=a.length<=b.length?a:b, lo=a.length<=b.length?b:a; if(!sh||sh.length<5||sh===lo||!lo.startsWith(sh))return false; return /[,;]/.test(lo[sh.length]); };
const nameToIds=new Map(), casToIds=new Map(), korToIngr=new Map();
const push=(m,k,id)=>{const a=m.get(k);if(a)a.push(id);else m.set(k,[id]);};
for (const i of ingredients){ const cn=i.inci_name?canonName(i.inci_name):""; if(cn)push(nameToIds,cn,i.id); if(i.cas_no)for(const c of casTokens(i.cas_no))push(casToIds,c,i.id); if(i.korean_name&&cn){const k=i.korean_name.trim();const a=korToIngr.get(k);if(a)a.push({id:i.id,cn});else korToIngr.set(k,[{id:i.id,cn}]);} }
const siblingIds=new Map();
for (const i of ingredients){ const set=new Set([i.id]); const cn=i.inci_name?canonName(i.inci_name):""; if(cn)for(const id of nameToIds.get(cn)??[])set.add(id); if(i.cas_no)for(const c of casTokens(i.cas_no))for(const id of casToIds.get(c)??[])set.add(id); if(i.korean_name&&cn){for(const e of korToIngr.get(i.korean_name.trim())??[]){if(e.id!==i.id&&isSynPrefix(cn,e.cn))set.add(e.id);}} if(set.size>1)siblingIds.set(i.id,Array.from(set)); }

function sanitize(s){return s.replace(/[,()%_\\"]/g," ").trim();}
function findIngredient(query){
  const safe=sanitize(query).toLowerCase(); if(!safe)return null;
  const inci=byInciLower.get(safe); if(inci)return inci;
  const kor=byKorLower.get(safe); if(kor)return kor;
  if(/^\d{1,7}-\d{2}-\d$/.test(query.trim())){const cas=byCas.get(query.trim());if(cas)return cas;}
  let best=null,bestScore=Infinity;
  for(const ing of ingredients){
    const inci=ing.inci_name?ing.inci_name.toLowerCase():null;
    const kor=ing.korean_name?ing.korean_name.toLowerCase():null;
    let score=Infinity;
    if(inci&&inci.includes(safe))score=Math.min(score,(inci.startsWith(safe)?0:1000)+inci.length);
    if(kor&&kor.includes(safe))score=Math.min(score,(kor.startsWith(safe)?0:1000)+kor.length);
    if(ing.chinese_name&&ing.chinese_name.includes(query))score=Math.min(score,500+ing.chinese_name.length);
    if(ing.japanese_name&&ing.japanese_name.includes(query))score=Math.min(score,500+ing.japanese_name.length);
    if(score<bestScore){bestScore=score;best=ing;}
  }
  return best;
}
function bucketFor(ids,code){
  let merged=null;
  for(const id of ids){const b=regsByIC.get(id)?.get(code);if(b&&b.length)(merged??=[]).push(...b);}
  if(!merged)return undefined;
  const byPriority=(a,b)=>{const pa=a.source_priority??0,pb=b.source_priority??0;if(pa!==pb)return pb-pa;return (b.last_verified_at??"").localeCompare(a.last_verified_at??"");};
  const winStatus=[...merged].sort(byPriority)[0].status;
  const detailScore=(r)=>{const c=r.conditions??"";const identityOnly=c.length<20||/등재 \(Reference \d+\)/.test(c);const hasDetail=!identityOnly&&c.length>=60;return (r.max_concentration!=null?2:0)+(hasDetail?1:0);};
  merged.sort((a,b)=>{const aw=a.status===winStatus?1:0,bw=b.status===winStatus?1:0;if(aw!==bw)return bw-aw;const da=detailScore(a),db=detailScore(b);if(da!==db)return db-da;return byPriority(a,b);});
  const seen=new Set();
  return merged.filter((r)=>{const k=`${r.source_document??""}|${r.source_url??""}|${r.status}`;if(seen.has(k))return false;seen.add(k);return true;});
}
function lookup(query, codes){
  const ing=findIngredient(query); if(!ing)return {ingredient:null};
  const ids=siblingIds.get(ing.id)??[ing.id];
  const out={ingredient:ing,ids,results:{}};
  for(const code of (codes||countries.map(c=>c.code))){
    const b=bucketFor(ids,code); const row=b?.[0];
    if(row)out.results[code]={status:row.status,max:row.max_concentration,unit:row.concentration_unit,priority:row.source_priority,src:row.source_document,nSources:b.length,condLen:(row.conditions||"").length};
  }
  return out;
}

module.exports={lookup,findIngredient,ingredients,regs,regsByIC,byId,siblingIds,quarSet,countries,bucketFor};

// CLI: node verify-groundtruth.cjs "<query>" [CC,CC]
if(require.main===module){
  const q=process.argv[2];
  const codes=process.argv[3]?process.argv[3].split(","):null;
  if(!q){console.log("usage: node verify-groundtruth.cjs <query> [CC,..]");process.exit(0);}
  const r=lookup(q,codes);
  if(!r.ingredient){console.log("NOT FOUND:",q);process.exit(0);}
  console.log("INGREDIENT:",r.ingredient.inci_name,"| KR:",r.ingredient.korean_name,"| JP:",r.ingredient.japanese_name,"| CAS:",r.ingredient.cas_no);
  console.log("siblings:",r.ids.length);
  for(const [cc,v] of Object.entries(r.results)){
    console.log(`  ${cc}: ${v.status} | max=${v.max}${v.unit||""} | tier-pri=${v.priority} | nSrc=${v.nSources} | ${v.src||""}`.slice(0,160));
  }
}
