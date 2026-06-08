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

// status 판단기 교정 미러(data-loader 와 동일) — banned 오분류를 restricted 로 교정.
try {
  const corr = new Map();
  for (const c of (J("status-overrides.json").corrections || [])) if (c && c.ingredient_id && c.country_code) corr.set(`${c.ingredient_id}:${c.country_code}`, c);
  if (corr.size) for (const r of regs) {
    const c = corr.get(`${r.ingredient_id}:${r.country_code}`);
    if (!c || r.status !== c.from) continue;
    if (c.source_match && !(r.source_document || "").includes(c.source_match)) continue;
    r.status = c.to;
  }
} catch {}

// indices
const byInciLower = new Map(), byKorLower = new Map(), byCas = new Map(), byId = new Map();
for (const i of ingredients) {
  byId.set(i.id, i);
  if (i.inci_name) byInciLower.set(i.inci_name.toLowerCase(), i);
  if (i.korean_name) byKorLower.set(i.korean_name.toLowerCase(), i);
  if (i.cas_no) for (const cas of i.cas_no.split(/[\s,;]+/)) if (cas.trim()) byCas.set(cas.trim(), i);
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
const casTokens = (raw) => raw.split(/[\s,;]+/).map((c)=>c.trim()).filter(isValidCas);  // lib 미러: 쉼표/세미콜론 분리(다중 CAS 형제링크)
const isSynPrefix = (a,b) => { const sh=a.length<=b.length?a:b, lo=a.length<=b.length?b:a; if(!sh||sh.length<5||sh===lo||!lo.startsWith(sh))return false; return /[,;]/.test(lo[sh.length]); };
const neKey=(s)=>s.toLowerCase().replace(/[^a-z0-9]/g,"").replace(/s$/,""); // 정규화 영문키(data-loader 미러)
// 식별 판단기(Gemini consensus) 병합 링크 — data-loader 미러
const identityLinks=new Map();
try{for(const pr of (J("identity-overrides.json").pairs||[])){if(!pr.ids||pr.ids.length<2)continue;for(const a of pr.ids)for(const b of pr.ids)if(a!==b){const s=identityLinks.get(a)||identityLinks.set(a,[]).get(a);if(!s.includes(b))s.push(b);}}}catch{}
const nameToIds=new Map(), casToIds=new Map(), korToIngr=new Map(), neKorToIds=new Map(), codeToIds=new Map();
const push=(m,k,id)=>{const a=m.get(k);if(a)a.push(id);else m.set(k,[id]);};
for (const i of ingredients){ const cn=i.inci_name?canonName(i.inci_name):""; if(cn)push(nameToIds,cn,i.id); if(i.cas_no)for(const c of casTokens(i.cas_no))push(casToIds,c,i.id); if(i.kcia_code)push(codeToIds,String(i.kcia_code).trim(),i.id); if(i.korean_name){const ne=i.inci_name?neKey(i.inci_name):"";if(ne&&ne.length>=4)push(neKorToIds,ne+"|"+i.korean_name.trim(),i.id);} if(i.korean_name&&cn){const k=i.korean_name.trim();const a=korToIngr.get(k);if(a)a.push({id:i.id,cn});else korToIngr.set(k,[{id:i.id,cn}]);} }
const siblingIds=new Map();
for (const i of ingredients){ const set=new Set([i.id]); const cn=i.inci_name?canonName(i.inci_name):""; if(cn)for(const id of nameToIds.get(cn)??[])set.add(id); if(i.cas_no)for(const c of casTokens(i.cas_no))for(const id of casToIds.get(c)??[])set.add(id); if(i.kcia_code)for(const id of codeToIds.get(String(i.kcia_code).trim())??[])set.add(id); for(const id of identityLinks.get(i.id)??[])set.add(id); if(i.korean_name){const ne=i.inci_name?neKey(i.inci_name):"";if(ne&&ne.length>=4)for(const id of neKorToIds.get(ne+"|"+i.korean_name.trim())??[])set.add(id);} if(i.korean_name&&cn){for(const e of korToIngr.get(i.korean_name.trim())??[]){if(e.id!==i.id&&isSynPrefix(cn,e.cn))set.add(e.id);}} if(set.size>1)siblingIds.set(i.id,Array.from(set)); }

function sanitize(s){return s.replace(/[,()%_\\"]/g," ").replace(/\s+/g," ").trim();}
function findIngredient(query){
  const safe=sanitize(query).toLowerCase(); if(!safe)return null;
  const inci=byInciLower.get(safe); if(inci)return inci;
  const kor=byKorLower.get(safe); if(kor)return kor;
  if(/^\d{1,7}-\d{2}-\d$/.test(query.trim())){const cas=byCas.get(query.trim());if(cas)return cas;}
  let best=null,bestScore=Infinity;
  for(const ing of ingredients){
    const inci=ing.inci_name?sanitize(ing.inci_name.toLowerCase()):null;
    const kor=ing.korean_name?sanitize(ing.korean_name.toLowerCase()):null;
    let score=Infinity;
    if(inci&&inci.includes(safe))score=Math.min(score,(inci===safe?0:inci.startsWith(safe)?1:1000)+inci.length);
    if(kor&&kor.includes(safe))score=Math.min(score,(kor===safe?0:kor.startsWith(safe)?1:1000)+kor.length);
    if(ing.chinese_name&&ing.chinese_name.includes(query))score=Math.min(score,500+ing.chinese_name.length);
    if(ing.japanese_name&&ing.japanese_name.includes(query))score=Math.min(score,500+ing.japanese_name.length);
    if(score===Infinity&&ing.synonyms){for(const syn of ing.synonyms){const s=syn.toLowerCase();if(s.includes(safe)){score=2000+(s.startsWith(safe)?0:1000)+s.length;break;}}}
    if(score<bestScore){bestScore=score;best=ing;}
  }
  return best;
}
function bucketFor(ids,code){
  let merged=null;
  for(const id of ids){const b=regsByIC.get(id)?.get(code);if(b&&b.length)(merged??=[]).push(...b);}
  if(!merged)return undefined;
  const sevRank=s=>s==="banned"?3:s==="restricted"?2:(s==="allowed"||s==="listed")?1:0; // lib 미러: 동일prio 동률시 severity 우선
  const byPriority=(a,b)=>{const pa=a.source_priority??0,pb=b.source_priority??0;if(pa!==pb)return pb-pa;const sa=sevRank(a.status),sb=sevRank(b.status);if(sa!==sb)return sb-sa;return (b.last_verified_at??"").localeCompare(a.last_verified_at??"");};
  const winStatus=[...merged].sort(byPriority)[0].status;
  const detailScore=(r)=>{const c=r.conditions??"";const identityOnly=c.length<20||/등재 \(Reference \d+\)/.test(c);const hasDetail=!identityOnly&&c.length>=60;return (r.max_concentration!=null?2:0)+(hasDetail?1:0);};
  merged.sort((a,b)=>{const aw=a.status===winStatus?1:0,bw=b.status===winStatus?1:0;if(aw!==bw)return bw-aw;const da=detailScore(a),db=detailScore(b);if(da!==db)return db-da;return byPriority(a,b);});
  const seen=new Set();
  return merged.filter((r)=>{const k=`${r.source_document??""}|${r.source_url??""}|${r.status}`;if(seen.has(k))return false;seen.add(k);return true;});
}
// lib/regulations-query.ts buildCanonical 미러 — 형제 그룹의 한국 등록 표준명 대표 선택.
function buildCanonical(ids, resolved){
  const members=ids.map(id=>byId.get(id)).filter(Boolean);
  if(members.length<=1)return resolved;
  const score=(m)=>{const inci=m.inci_name||"";const allCaps=inci===inci.toUpperCase()&&/[A-Z]/.test(inci);const junk=/,?\s*C(?:AS|I)\s*[\d\-]/i.test(inci)||/\[\d\]/.test(inci)||/[,;]/.test(inci);return (m.kcia_code?2000:0)+(m.korean_name?1000:0)+(allCaps?0:100)+(junk?0:50)+(m.cas_no?10:0)-inci.length*0.01;};
  const rep=[...members].sort((a,b)=>score(b)-score(a))[0];
  const repInci=(rep.inci_name||"").trim();
  const firstOf=(f)=>{if(rep[f])return rep[f];for(const m of members)if(m[f])return m[f];return null;};
  const casSet=[];for(const m of members)for(const c of String(m.cas_no||"").split(/[\s,;]+/)){const t=c.trim();if(/^\d{2,7}-\d{2}-\d$/.test(t)&&!casSet.includes(t))casSet.push(t);}
  const synSet=[];const ri=repInci.toLowerCase(),rk=(rep.korean_name||"").trim().toLowerCase();
  const addSyn=s=>{const v=(s||"").trim();if(!v)return;if(v.toLowerCase()===ri||v.toLowerCase()===rk)return;if(!synSet.some(x=>x.toLowerCase()===v.toLowerCase()))synSet.push(v);};
  for(const m of members){(m.synonyms||[]).forEach(addSyn);if(m.id!==rep.id)addSyn(m.inci_name);}
  return {id:rep.id,inci_name:repInci,korean_name:firstOf("korean_name"),chinese_name:firstOf("chinese_name"),japanese_name:firstOf("japanese_name"),cas_no:casSet.length?casSet.join(", "):null,synonyms:synSet,description:firstOf("description"),function_category:firstOf("function_category"),function_description:firstOf("function_description"),kcia_code:firstOf("kcia_code")};
}
function lookup(query, codes){
  const resolved=findIngredient(query); if(!resolved)return {ingredient:null};
  const ids=siblingIds.get(resolved.id)??[resolved.id];
  const ing=buildCanonical(ids,resolved);
  const out={ingredient:ing,ids,results:{}};
  for(const code of (codes||countries.map(c=>c.code))){
    const b=bucketFor(ids,code); const row=b?.[0];
    if(row)out.results[code]={status:row.status,max:row.max_concentration,unit:row.concentration_unit,priority:row.source_priority,src:row.source_document,nSources:b.length,condLen:(row.conditions||"").length};
  }
  return out;
}

module.exports={lookup,findIngredient,ingredients,regs,regsByIC,byId,siblingIds,quarSet,countries,bucketFor,buildCanonical};

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
