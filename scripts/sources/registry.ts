// 15개국 공식 변경 감지 소스 레지스트리.
//
// 원칙:
// - tier='primary': 관보(official gazette) 또는 법적 확정 경로
// - tier='secondary': 규제기관 공고/가이드라인 게시판
// - tier='tertiary': 협회·민간 요약 (참고용)
// - detect_method:
//     'head' = HTTP HEAD로 ETag/Last-Modified 비교 (가장 가벼움)
//     'hash' = GET 후 content_selector CSS selector로 추출한 섹션만 SHA-256
//     'rss'  = RSS/Atom guid 리스트 diff
//     'api'  = JSON API의 updatedAt/version 필드 비교
//
// 실제 URL은 시간이 지나며 깨질 수 있음. 각 항목은 detected_changes 이벤트가
// 'source_unavailable'로 5회 이상 연속 기록되면 알림 — 운영 중 교체.

export type DetectMethod = "head" | "hash" | "rss" | "api";
export type Tier = "primary" | "secondary" | "tertiary";

export interface RegulationSourceSeed {
  country_code: string;
  name: string;
  description?: string;
  url: string;
  detect_method: DetectMethod;
  content_selector?: string;
  check_cadence_hours?: number;
  tier: Tier;
  priority?: number;
}

export const REGULATION_SOURCES: RegulationSourceSeed[] = [
  // ======================= KR =======================
  {
    country_code: "KR",
    name: "MFDS 공공데이터 API updatedAt",
    description: "식약처 공공데이터 4종 API 메타데이터 갱신 확인 (primary 데이터 경로)",
    url: "https://www.data.go.kr/data/15067353/openapi.do",
    detect_method: "api",
    check_cadence_hours: 24,
    tier: "primary",
    priority: 100,
  },
  // KR secondary는 보류 — MFDS 공공데이터 API(primary)가 이미 고시 개정 데이터 포함하고,
  // m_207/list.do가 브라우저 외 UA에 connection reset 반환. Phase 4에서 Playwright 기반 fetcher
  // 도입 후 재활성화. seed.ts에서 active=false로 주입.
  {
    country_code: "KR",
    name: "MFDS 화장품 법령·고시 공고",
    description: "[비활성] 봇 차단 — MFDS API가 primary. Phase 4에서 Playwright fetcher로 재도입.",
    url: "https://www.mfds.go.kr/brd/m_207/list.do",
    detect_method: "hash",
    content_selector: "table.board_list",
    check_cadence_hours: 168,
    tier: "secondary",
    priority: 0,
  },

  // ======================= CN =======================
  {
    country_code: "CN",
    name: "NMPA 化妆品监管公告",
    description: "NMPA 화장품 감독관리 공고 게시판 — IECIC 개정·금지원료 공고의 1차 신호",
    url: "https://www.nmpa.gov.cn/xxgk/fgwj/gzwj/gzwjhzhp/index.html",
    detect_method: "hash",
    content_selector: "ul.list",
    check_cadence_hours: 24,
    tier: "primary",
    priority: 100,
  },
  {
    country_code: "CN",
    name: "NMPA 化妆品抽检通告",
    description: "NMPA 화장품 검사 결과 공고",
    url: "https://www.nmpa.gov.cn/xxgk/ggtg/hzhpgztg/index.html",
    detect_method: "hash",
    content_selector: "ul.list",
    check_cadence_hours: 168,
    tier: "secondary",
    priority: 40,
  },

  // ======================= EU =======================
  // EU EUR-Lex 검색·문서 페이지 전부 async 렌더링 + 봇 차단(HTTP 202). 정적 fetch 불가.
  // Phase 4에서 Playwright 기반 fetcher 필수. 임시: CosIng secondary에 우선 의존.
  {
    country_code: "EU",
    name: "EUR-Lex Cosmetic Regulation amendments",
    description: "[Phase4 대기] EUR-Lex 동적 페이지 — Playwright fetcher 도입 후 활성화",
    url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32009R1223",
    detect_method: "hash",
    content_selector: "body",
    check_cadence_hours: 168,
    tier: "primary",
    priority: 50,
  },
  {
    country_code: "EU",
    name: "CosIng Database",
    description: "EU 화장품 성분 공식 DB — Annex II/III/IV/V/VI 수록",
    url: "https://ec.europa.eu/growth/tools-databases/cosing/index.cfm?fuseaction=search.simple",
    detect_method: "hash",
    content_selector: "body",
    check_cadence_hours: 168,
    tier: "secondary",
    priority: 90,
  },

  // ======================= US =======================
  {
    country_code: "US",
    name: "Federal Register — Cosmetics (21 CFR 700)",
    description: "미국 연방관보 — 화장품 관련 규칙 개정 RSS",
    url: "https://www.federalregister.gov/api/v1/articles.rss?conditions%5Bcfr%5D%5Btitle%5D=21&conditions%5Bcfr%5D%5Bpart%5D=700",
    detect_method: "rss",
    check_cadence_hours: 24,
    tier: "primary",
    priority: 100,
  },
  {
    country_code: "US",
    name: "FDA Cosmetics announcements",
    description: "FDA 화장품 공지 — MoCRA 등록·recall·경고",
    url: "https://www.fda.gov/cosmetics",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 48,
    tier: "secondary",
    priority: 80,
  },

  // ======================= JP =======================
  {
    country_code: "JP",
    name: "厚生労働省 化粧品基準改正",
    description: "일본 후생노동성 — 화장품기준(昭和55年厚生省告示 제331호) 개정 고시",
    url: "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/iyakuhin/keshouhin/",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 24,
    tier: "primary",
    priority: 100,
  },

  // ======================= TW =======================
  {
    country_code: "TW",
    name: "TFDA 化粧品衛生安全管理法規",
    description: "대만 TFDA — 화장품 안전관리 법규·positive list",
    url: "https://www.fda.gov.tw/TC/siteList.aspx?sid=11497",
    detect_method: "hash",
    content_selector: "div.ContentArea",
    check_cadence_hours: 24,
    tier: "primary",
    priority: 100,
  },

  // ======================= ASEAN 6 =======================
  {
    country_code: "VN",
    name: "Vietnam DAV 공고",
    description: "베트남 의약품관리국 — 화장품 공문(circulars)",
    url: "https://dav.gov.vn/",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 48,
    tier: "primary",
    priority: 80,
  },
  {
    country_code: "TH",
    name: "Thailand FDA Cosmetic notifications",
    description: "태국 FDA 메인 도메인 — Cosmetic Control Division 공지 경로는 응답 없음, 메인 hash diff로 대체",
    url: "https://www.fda.moph.go.th/",
    detect_method: "hash",
    content_selector: "body",
    check_cadence_hours: 72,
    tier: "primary",
    priority: 60,
  },
  {
    country_code: "ID",
    name: "Indonesia BPOM Cosmetic",
    description: "인도네시아 BPOM — 화장품 규제·공지",
    url: "https://www.pom.go.id/",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 48,
    tier: "primary",
    priority: 80,
  },
  {
    country_code: "MY",
    name: "Malaysia NPRA Cosmetic",
    description: "말레이시아 NPRA — 화장품 규제 공지",
    url: "https://www.npra.gov.my/index.php/en/",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 72,
    tier: "primary",
    priority: 70,
  },
  {
    country_code: "PH",
    name: "Philippines FDA Cosmetic",
    description: "필리핀 FDA — 화장품 공지",
    url: "https://www.fda.gov.ph/cosmetics/",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 72,
    tier: "primary",
    priority: 70,
  },
  {
    country_code: "SG",
    name: "Singapore HSA Cosmetic",
    description: "싱가포르 HSA — 화장품 규제",
    url: "https://www.hsa.gov.sg/cosmetic-products",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 72,
    tier: "primary",
    priority: 70,
  },

  // ======================= 아메리카 =======================
  {
    country_code: "BR",
    name: "ANVISA Cosméticos",
    description: "브라질 ANVISA — 화장품 규정·공지",
    url: "https://www.gov.br/anvisa/pt-br/assuntos/cosmeticos",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 48,
    tier: "primary",
    priority: 80,
  },
  {
    country_code: "AR",
    name: "ANMAT Cosméticos",
    description: "아르헨티나 ANMAT — 화장품 관련 공지·규정",
    url: "https://www.argentina.gob.ar/anmat/regulados/cosmeticos",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 72,
    tier: "primary",
    priority: 70,
  },
  {
    country_code: "CA",
    name: "Health Canada Cosmetic Ingredient Hotlist",
    description: "캐나다 Health Canada — 화장품 성분 Hotlist (금지·제한)",
    url: "https://www.canada.ca/en/health-canada/services/consumer-product-safety/cosmetics/cosmetic-ingredient-hotlist-prohibited-restricted-ingredients/hotlist.html",
    detect_method: "hash",
    content_selector: "main",
    check_cadence_hours: 48,
    tier: "primary",
    priority: 80,
  },
];
