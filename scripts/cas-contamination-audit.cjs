#!/usr/bin/env node
// CAS 오염 의심 감사 — review-queue(자동 *수정 안 함*·관찰만). 다중 CAS 필드의 한 토큰이 *다른
// 이름*의 단일-CAS 물질 것이고 이름 토큰이 0겹침이면 후보로 표면화. PCNB↔1-chloro-4-nitrobenzene,
// steam-cracked-residue↔magnesium-aspartate 같은 *별개물질 오병합*(형제병합→CJK명 오표기)을 잡는다.
//
// ⚠️ 자동 수정 금지(분별력): 0겹침 후보 대부분은 *같은 물질의 다른 명명법*(Octamethylcyclotetra-
// siloxane=Cyclotetrasiloxane D4, Butylparaben=Butyl 4-hydroxybenzoate, Bunsenite=Nickel Monoxide,
// 산↔염 그룹…)이라 자동 분리하면 정당병합을 깬다. 신뢰 가능한 discriminator 없음 → 사람/Claude 검토
// 후 guardian COMPOUND_CAS_FIX 에 명시 교정. 이 큐의 *증가* = 신규 오염 or 파서버그 조기경보.
//
// 산출: public/data/cas-contamination-suspects.json (검토 리스트). 위험 방향(다른 status 병합=
// false-allowed)은 별도 false-allowed 스캔(=0)이 보증. 이 큐는 *표시 정확성*(CJK명 등) 보조 감사.
const fs = require("fs");
const path = require("path");
const G = require(path.join(__dirname, "verify-groundtruth.cjs"));
const { ingredients } = G;
const DATA = path.join(__dirname, "..", "public", "data");
const apply = process.argv[2] === "--write";

const isValid = (c) => /^\d{1,7}-\d{2}-\d$/.test(c);
// 흔한 비-식별 토큰(같은 물질의 부위/염/형태 차이라 0겹침 오탐을 키우는 것 제외)
const STOP = new Set(["acid", "extract", "oil", "and", "its", "salts", "salt", "the", "of", "powder",
  "water", "leaf", "root", "flower", "fruit", "seed", "stem", "bark", "resin", "gum", "wood", "peel",
  "juice", "butter", "generic", "cas", "no", "and", "form"]);
const toks = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
  .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)));

// 단일-CAS 물질 맵: cas -> [ingredient]
const single = new Map();
for (const i of ingredients) {
  if (!i.cas_no) continue;
  const t = i.cas_no.split(/[\s,;]+/).map((c) => c.trim()).filter(isValid);
  if (t.length === 1) { const a = single.get(t[0]) || []; a.push(i); single.set(t[0], a); }
}

const suspects = [];
const seen = new Set();
for (const i of ingredients) {
  if (!i.cas_no) continue;
  const t = i.cas_no.split(/[\s,;]+/).map((c) => c.trim()).filter(isValid);
  if (t.length < 2) continue;
  const myt = toks(i.inci_name);
  if (!myt.size) continue;
  for (const c of t) {
    const owners = single.get(c); if (!owners) continue;
    for (const o of owners) {
      if (o.id === i.id) continue;
      const ot = toks(o.inci_name); if (!ot.size) continue;
      const overlap = [...myt].some((x) => ot.has(x));
      if (!overlap) {
        const key = [i.inci_name, c, o.inci_name].join("|");
        if (seen.has(key)) continue; seen.add(key);
        suspects.push({ inci: i.inci_name, shared_cas: c, conflicts_with: o.inci_name });
      }
    }
  }
}
suspects.sort((a, b) => (a.inci || "").localeCompare(b.inci || ""));
console.log(`CAS 오염 의심(토큰 0겹침 다중CAS↔다른이름 단일CAS): ${suspects.length} 후보`);
console.log("⚠️ 대부분 같은물질 다른명명(legit) — 자동수정 금지. 검토 후 guardian 명시교정. 큐 증가=신규오염/파서버그 경보.");
for (const s of suspects.slice(0, 25)) console.log(`  [${s.shared_cas}] ${(s.inci || "").slice(0, 34)} ⟷ ${(s.conflicts_with || "").slice(0, 34)}`);
if (suspects.length > 25) console.log(`  ... +${suspects.length - 25}`);
if (apply) {
  fs.writeFileSync(path.join(DATA, "cas-contamination-suspects.json"), JSON.stringify({
    generated: "cas-contamination-audit",
    note: "다중CAS↔다른이름 단일CAS 0토큰겹침 검토큐. 대부분 같은물질 다른명명(legit). 자동수정 금지(분별력). 검토 후 guardian COMPOUND_CAS_FIX 명시교정. 위험방향(다른status)은 false-allowed 스캔이 별도 보증. 큐 *증가* = 신규오염/파서버그 점검.",
    count: suspects.length, suspects,
  }, null, 2));
  console.log("\ncas-contamination-suspects.json 기록.");
}
