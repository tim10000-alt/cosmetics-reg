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

type Ing = { id: string; chinese_name?: string | null; korean_name?: string | null; inci_name?: string | null };
const ing = JSON.parse(readFileSync(join(DATA, "ingredients.json"), "utf8")).rows as Ing[];
const byId = new Map<string, Ing>(ing.map((i) => [i.id, i]));
const dict = new Map<string, string>();          // 글로벌 chinese_name→korean_name (보조)
for (const i of ing) {
  const zh = (i.chinese_name || "").trim(), ko = (i.korean_name || "").trim();
  if (zh && ko && !dict.has(zh)) dict.set(zh, ko);
}
const CJK_RE = /[㐀-鿿]/;
// 그 행의 성분으로 읽을 수 있는 이름: 한국어명 → (중문명 글로벌사전) → 영문 INCI → 원문.
// 사용자가 "원문(중국어)을 못 읽으니 한글로 어떤 항목인지 보여달라" → 행의 성분 한국어명이 권위.
function readableName(zhName: string, ig?: Ing): string {
  const ko = (ig?.korean_name || "").trim();
  if (ko) return ko;
  const g = dict.get(zhName.trim());
  if (g) return g;
  const inci = (ig?.inci_name || "").trim();
  if (inci && !CJK_RE.test(inci)) return inci;   // 영문 INCI(국제 표준명) — 최소한 읽을 수 있음
  return zhName;                                  // 정말 아무것도 없으면 원문(추측 금지)
}

function detCN(cond: string, ig?: Ing): string {
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
  s = s.replace(/중문명칭?[:：]\s*([^\n]+)/g, (_m, name: string) => `성분명: ${readableName(name.trim(), ig)}`);
  return s.replace(/[ \t]{2,}/g, " ");
}

const obj = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { translations: {} };
const t: Record<string, string> = obj.translations ?? {};

const cn = JSON.parse(readFileSync(join(DATA, "regulations", "CN.json"), "utf8")).rows as { conditions?: string | null; ingredient_id?: string }[];
const seen = new Set<string>();
let added = 0, koName = 0, inciName = 0, zhName = 0;
for (const r of cn) {
  const c = r.conditions;
  if (typeof c !== "string" || !c.includes("중문명")) continue;
  const k = strKey(c);
  if (seen.has(k)) continue;
  seen.add(k);
  const ig = r.ingredient_id ? byId.get(r.ingredient_id) : undefined;
  const ko = detCN(c, ig);
  if (ko !== c && ko !== t[k]) { t[k] = ko; added++; }
  // 통계: 성분명을 무엇으로 표기했나
  const m = /중문명칭?[:：]\s*([^\n]+)/.exec(c);
  if (m) { const nm = readableName(m[1].trim(), ig); if (ig?.korean_name) koName++; else if (nm !== m[1].trim() && !CJK_RE.test(nm)) inciName++; else if (CJK_RE.test(nm)) zhName++; }
}
// 잔존 중국어 *구조 라벨* 결정론 정리(전 캐시 — TW/JP 포함). Gemini 가 일부 배치서 안 옮긴
// 고정 라벨(項次=항목·번호, 備註=비고)만 치환. 내용은 이미 한글이라 100% 안전.
let labelFixed = 0;
for (const k of Object.keys(t)) {
  const before = t[k];
  let v = before.replace(/項次/g, "항목").replace(/備註/g, "비고").replace(/限量標準/g, "한도 기준");
  v = v.replace(/비고\s*\(\s*비고\s*원문\s*\)/g, "비고 (원문)");   // "비고 (備註 원문)" 중복 정리
  if (v !== before) { t[k] = v; labelFixed++; }
}
console.log(`잔존 중국어 라벨 정리(項次/備註): ${labelFixed}`);

writeFileSync(OUT, JSON.stringify({ generated: "cn-deterministic+translate-fields", count: Object.keys(t).length, translations: t }, null, 0));
console.log(`CN 결정론 추가/갱신 ${added} · 성분명: 한국어 ${koName} · 영문INCI ${inciName} · 원문잔존 ${zhName} · 총 캐시 ${Object.keys(t).length}`);
