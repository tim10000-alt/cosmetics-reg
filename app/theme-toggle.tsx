"use client";

import { useEffect, useState } from "react";

// 다크/라이트 수동 토글 — 선택을 localStorage 에 저장(기기별 유지). 미선택 시 시스템 설정 따름
// (layout 인라인 스크립트가 초기 .dark 를 paint 전에 적용 = 무깜빡임).
export default function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [dark, setDark] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMounted(true);
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch {}
  };

  // 하이드레이션 불일치 방지 — 마운트 전엔 자리만 차지(아이콘 미정).
  return (
    <button
      onClick={toggle}
      aria-label={dark ? "라이트 모드로" : "다크 모드로"}
      title={dark ? "라이트 모드" : "다크 모드"}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-300 text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {mounted ? (dark ? "☀️" : "🌙") : ""}
    </button>
  );
}
