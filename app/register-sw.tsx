"use client";

import { useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";

// 서비스워커 등록 — 첫 방문 후 오프라인 동작 + 홈 화면 설치 가능(PWA).
// 하위경로 배포 시 SW 는 base path 아래에서 서빙되고 그 scope 만 제어한다.
export default function RegisterSW() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker
        .register(`${BASE_PATH}/sw.js`, { scope: `${BASE_PATH}/` })
        .catch(() => {});
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);
  return null;
}
