import type { MetadataRoute } from "next";
import { BASE_PATH } from "@/lib/base-path";

// PWA 매니페스트 — "홈 화면 추가" 시 standalone(전체화면) 앱처럼 실행.
// 하위경로 배포(GitHub Pages)에서도 동작하도록 모든 경로에 BASE_PATH 적용.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: `${BASE_PATH}/`,
    name: "화장품 원료 규제 검색",
    short_name: "규제검색",
    description:
      "19개국 화장품 원료의 배합금지·한도·positive list 수록 여부를 공식 기관 원본에서 직접 조회.",
    start_url: `${BASE_PATH}/`,
    scope: `${BASE_PATH}/`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b1020",
    theme_color: "#0b1020",
    lang: "ko",
    icons: [
      {
        src: `${BASE_PATH}/icons/icon-192.png`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${BASE_PATH}/icons/icon-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${BASE_PATH}/icons/icon-maskable-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
