import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { strKey } from "../lib/strhash";

// CN IECIC 조건문 결정론 한국어화 (Gemini 0 — 추측 오역 원천 차단).
// 성분명은 *데이터 자체의 검증된* chinese_name→korean_name(식약처/KCIA) 으로만 매핑.
// 사전에 없으면(한국어명 부재) 원문(중국어) 유지 = 추측 금지. 고정 문구(已使用化妆品原料目录·
// 序号·备注)는 결정론 치환. 결과를 translations.json 에 추가(표시층이 strKey 로 조회).
//
// 이 방식이 [[Gemini 성분명 오역]] 재발을 막는다: 화학명은 LLM 이 아니라 권위 데이터로만 번역.

const DATA = join(__dirname, "..", "public", "data");
const OUT = join(DATA, "translations.json");

const ing = JSON.parse(readFileSync(join(DATA, "ingredients.json"), "utf8")).rows as { chinese_name?: string | null; korean_name?: string | null }[];
const dict = new Map<string, string>();
for (const i of ing) {
  const zh = (i.chinese_name || "").trim(), ko = (i.korean_name || "").trim();
  if (zh && ko && !dict.has(zh)) dict.set(zh, ko);
}

function detCN(cond: string): string {
  let s = cond;
  // 고정 문구(결정론·안전).
  s = s.replace(/已使用化妆品原料目录/g, "사용된 화장품 원료 목록");
  s = s.replace(/按照《化妆品安全技术规范》要求使用/g, "《화장품 안전기술규범》 요건에 따라 사용");
  s = s.replace(/《化妆品安全技术规范》禁用原料/g, "《화장품 안전기술규범》 금지 원료");  // 안전상 중요(IECIC 등재이나 금지)
  s = s.replace(/曾用名/g, "이전 명칭");
  s = s.replace(/包括/g, "포함: ");
  s = s.replace(/提取物/g, " 추출물");
  // 중복 라벨 "(序号)"·"(备注)" 제거(한국어 라벨 순번/비고 이미 있음).
  s = s.replace(/\s*[（(]\s*序号\s*[)）]/g, "").replace(/\s*[（(]\s*备注\s*[)）]/g, "");
  s = s.replace(/序号/g, "순번").replace(/备注/g, "비고");
  // "중문명[칭]: X" → 전체 문자열 사전(권위 chinese_name→korean_name) 적중 시 한국어, 아니면 원문
  // 유지(추측 금지 = 오역 방지). 한국어명 없는 복합 화학명은 원문(중국어+INCI)으로 남김.
  s = s.replace(/중문명칭?[:：]\s*([^\n]+)/g, (_m, name: string) => {
    const n = name.trim();
    const ko = dict.get(n) || dict.get(n.replace(/\s*추출물\s*$/, "提取物"));
    return ko ? `성분명: ${ko}` : `성분명: ${n}`;
  });
  return s.replace(/[ \t]{2,}/g, " ");
}

const obj = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { translations: {} };
const t: Record<string, string> = obj.translations ?? {};

const cn = JSON.parse(readFileSync(join(DATA, "regulations", "CN.json"), "utf8")).rows as { conditions?: string | null }[];
const seen = new Set<string>();
let added = 0, hitNames = 0, missNames = 0;
for (const r of cn) {
  const c = r.conditions;
  if (typeof c !== "string" || !c.includes("중문명")) continue;
  const k = strKey(c);
  if (seen.has(k)) continue;
  seen.add(k);
  const ko = detCN(c);
  if (ko !== c && ko !== t[k]) { t[k] = ko; added++; }
  const m = /중문명[:：]\s*([^\n]+)/.exec(c);
  if (m) { dict.has(m[1].trim()) ? hitNames++ : missNames++; }
}
writeFileSync(OUT, JSON.stringify({ generated: "cn-deterministic+translate-fields", count: Object.keys(t).length, translations: t }, null, 0));
console.log(`CN 결정론 추가/갱신 ${added} · 사전적중 ${hitNames} · 미적중(중문유지) ${missNames} · 총 캐시 ${Object.keys(t).length}`);
