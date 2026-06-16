import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { strKey } from "../lib/strhash";

// 번역 재발방지 검증 QA (CI 게이트) — 캐시된 번역을 원문과 대조해 *치명적* 오류를 자동 검출.
// 위반 발견 시 비정상 종료(CI 경보). [[Gemini 성분명 오역]] 재발 방지의 자동화 안전망.
//  ① 상태 뒤집힘: 원문 허용/positive 인데 번역 금지(또는 반대) — 규제사고.
//  ② 한도 손실(TW/JP 만): 원문의 한도 숫자(%, 소수)가 번역에 없음 — 한도 변조.
//     (CN 은 positive-list 순번/성분명이라 숫자=명명법 → 제외. TW/JP 조건문만 한도 보유.)
const DATA = join(__dirname, "..", "public", "data");
const cache: Record<string, string> = JSON.parse(readFileSync(join(DATA, "translations.json"), "utf8")).translations ?? {};

// 한도성 숫자(%, 소수) — 공백 정규화("0.05 %"=="0.05%")해서 비교(공백차 거짓양성 방지).
const limitNums = (s: string): string[] => (s.match(/\d+(?:[.,]\d+)?\s*%|\d+\.\d+/g) ?? []).map((x) => x.replace(/\s+/g, ""));
const flips: string[] = [];
const limitLoss: string[] = [];
let checked = 0;

for (const f of readdirSync(join(DATA, "regulations")).filter((x) => x.endsWith(".json"))) {
  const cc = f.slice(0, -5);
  for (const r of JSON.parse(readFileSync(join(DATA, "regulations", f), "utf8")).rows as Record<string, unknown>[]) {
    for (const field of ["conditions", "source_document"]) {
      const o = r[field];
      if (typeof o !== "string" || !o) continue;
      const ko = cache[strKey(o)];
      if (ko === undefined) continue;
      checked++;
      // ① 상태 뒤집힘
      const oAllow = /사용 가능|positive list|准用|准予使用/.test(o);
      const oBan = /禁止使用|不得使用|배합금지|사용 금지/.test(o);
      const kAllow = /사용 가능|positive list/.test(ko);
      const kBan = /배합금지|사용 금지/.test(ko);
      // 원문에 *없던* 금지/허용을 번역이 새로 만들면 flip(진짜 뒤집힘). 원문에 이미 둘 다 있으면
      // (조건부 하위제한 = "사용가능, 단 흡입제품 금지") 정상이므로 제외.
      if ((oAllow && !oBan && kBan && !/除外|제외|예외/.test(ko)) || (oBan && !oAllow && kAllow)) flips.push(`${cc}: ${o.slice(0, 50)} => ${ko.slice(0, 50)}`);
      // ② 한도 손실(TW/JP 한도 보유 조건문만)
      if ((cc === "TW" || cc === "JP") && field === "conditions") {
        const koSet = new Set(limitNums(ko));
        for (const n of new Set(limitNums(o))) if (!koSet.has(n)) { limitLoss.push(`${cc}: 한도 '${n}' 손실 :: ${o.slice(0, 50)}`); break; }
      }
    }
  }
}

console.log(`▶ 번역 검증: 대조 ${checked} · 상태뒤집힘 ${flips.length} · 한도손실(TW/JP) ${limitLoss.length}`);
for (const v of flips.slice(0, 20)) console.log("  ✗ FLIP", v);
for (const v of limitLoss.slice(0, 20)) console.log("  ✗ LIMIT", v);
if (flips.length || limitLoss.length) { console.error(`::error::번역 검증 실패 — 상태뒤집힘 ${flips.length}, 한도손실 ${limitLoss.length}`); process.exit(1); }
console.log("✓ 번역 검증 통과(치명 오류 0)");
