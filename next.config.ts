import type { NextConfig } from "next";

// Static export — Netlify 정적 호스팅 또는 `npx serve out`으로 로컬에서 단독 실행 가능.
// API routes / middleware / SSR 페이지 사용 안 함 (Phase 5b — Supabase·서버 의존 0).
// 모든 데이터는 클라이언트가 public/data/*.json 을 직접 fetch (인메모리 인덱스).
//
// 보안 헤더는 정적 export에서 next.config.headers()가 무시되므로 호스팅 측
// (Netlify의 [[headers]] / public/_headers)에서 적용한다.
// GitHub Pages 프로젝트 사이트(/cosmetics-reg 하위경로) 배포 시 빌드 env 로 주입.
// 미설정(로컬 npm start·루트 호스팅)이면 basePath 없음 → 기존 루트 동작 그대로.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
};

export default nextConfig;
