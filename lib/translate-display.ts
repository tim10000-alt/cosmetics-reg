// 표시층 한글화 — 일부 국가는 출처 문서명/조건문이 원문(대만 TFDA 번체·중국 NMPA·일본 MHLW
// 한자)으로 들어온다. 데이터(저장값)는 불변, *표시 시점*에만 한글로 치환한다.
// 결정론·가역·exact-match(부분 오역 위험 0)·일일 refresh 무관(매 조회 시 적용 → 새 데이터도 자동 한글).
//
// 키는 데이터에 실제로 존재하는 정확한 원문 문자열. 전수 스캔 결과 영향 필드(source_document·
// conditions)의 비-한글 원문은 아래 고정 집합으로 한정됨(대만 7·중국 1·일본 2).
// 새로운 원문이 생기면 여기에 한 줄 추가하면 된다(검출: 비ASCII·비한글 잔존 감사).

const MAP: Record<string, string> = {
  // ── 대만 TFDA 출처 표 이름 (化粧品禁限用成分管理規定 = 화장품 사용금지·제한 성분 관리규정) ──
  "TFDA 化粧品禁限用成分管理規定 — 化粧品禁止使用成分表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 사용금지 성분표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品防腐劑成分使用限制表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 보존제 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品色素成分使用限制表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 색소 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品成分使用限制表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 성분 사용제한표",
  "TFDA 化粧品禁限用成分管理規定 — 化粧品防曬劑成分使用限制表":
    "TFDA 화장품 사용금지·제한 성분 관리규정 — 화장품 자외선차단제 성분 사용제한표",
  // ── 대만 TFDA 조건문 ──
  "不得使用於染髮用途化粧品": "염모(헤어 염색)용 화장품에는 사용할 수 없음",
  "用 作 色 素 之 zirconium lakes, salts, pigments 及化粧品成分使用限制表中另有規定者除外。":
    "색소로 사용되는 지르코늄(zirconium) 레이크·염·안료, 및 화장품 성분 사용제한표에 별도 규정이 있는 경우는 제외.",
  // ── 중국 NMPA 출처 ──
  "NMPA IECIC (已使用化妆品原料目录)": "NMPA IECIC (사용된 화장품 원료 목록)",
  // ── 등록 원료 목록(registry_name) 표 이름 ──
  "TFDA 化粧品禁限用成分管理規定": "TFDA 화장품 사용금지·제한 성분 관리규정",
  "NMPA 已使用化妆品原料目录 (IECIC)": "NMPA 사용된 화장품 원료 목록 (IECIC)",
  "PMDA 標準成分 검색": "PMDA 표준성분 검색",
  // ── 일본 MHLW 출처 (化粧品基準 = 화장품기준) ──
  "JP MHLW 化粧品基準 (Standards for Cosmetics, Notification 331)":
    "JP MHLW 화장품기준 (Standards for Cosmetics, 고시 제331호)",
  "JP MHLW 化粧品基準 別表 1 (品目ごと承認対象成分 positive list)":
    "JP MHLW 화장품기준 별표1 (품목별 승인대상 성분 positive list)",
};

// 공백 변형(연속/엣지 공백)에도 매칭되도록 정규화 키 인덱스도 둔다.
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const NORM_MAP: Record<string, string> = {};
for (const [k, v] of Object.entries(MAP)) NORM_MAP[norm(k)] = v;

import { strKey } from "./strhash";

// 표시 텍스트를 한글로 치환. 우선순위:
//  ① Gemini 번역 캐시(translations.json — 해시키, 전수·장기 자동 누적)
//  ② 결정론 seed(위 MAP — 출처명·핵심 조건은 CI 없이도 즉시 한글)
//  ③ 없으면 원문 그대로(부분 오역 0). null/undefined 보존.
export function translateDisplay<T extends string | null | undefined>(
  s: T,
  cache?: Map<string, string> | null,
): T {
  if (s == null) return s;
  const str = s as string;
  if (cache) {
    const hit = cache.get(strKey(str));
    if (hit) return hit as T;
  }
  const direct = MAP[str];
  if (direct) return direct as T;
  const n = NORM_MAP[norm(str)];
  if (n) return n as T;
  return s;
}
