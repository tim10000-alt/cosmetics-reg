// 정적 배포의 base path. GitHub Pages 프로젝트 사이트는 /<repo> 하위경로로 서빙되므로
// 빌드 시 NEXT_PUBLIC_BASE_PATH=/cosmetics-reg 를 주입한다. 로컬(npm start)·루트 호스팅에서는
// 미설정 → 빈 문자열이라 기존 절대경로 동작 그대로 유지(100% 로컬 모드 무영향).
//
// next.config 의 basePath 는 next/link·_next 자산만 자동 prefix 한다. 수동 fetch("/data/..")
// 는 자동 prefix 되지 않으므로 이 헬퍼로 감싼다.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// 절대경로(/data/...) 앞에 base path 를 붙인다. p 는 항상 "/" 로 시작.
export const asset = (p: string): string => `${BASE_PATH}${p}`;
