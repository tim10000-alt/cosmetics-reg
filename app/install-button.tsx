"use client";

import { useEffect, useState } from "react";

// 설치 가능 시점에 beforeinstallprompt 이벤트가 온다(Android Chrome·데스크톱 Chrome/Edge).
type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// 눈에 보이는 "앱 설치" 버튼. beforeinstallprompt 가 와 있으면 한 번에 설치하고,
// 아직/안 오는 환경(이벤트 지연·iOS Safari·인앱 브라우저 등)에서는 수동 설치 안내를 띄운다.
// → 어떤 환경에서도 설치 경로가 항상 보이게(이전엔 이벤트가 안 오면 아무것도 안 보였음).
// 이미 설치(standalone)면 렌더 안 함.
export default function InstallButton() {
  const [prompt, setPrompt] = useState<BIPEvent | null>(null);
  const [standalone, setStandalone] = useState(true); // SSR 안전: 기본 숨김 → 마운트 후 판정
  const [showHelp, setShowHelp] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const inStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS Safari 홈 화면 실행 표식
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setStandalone(!!inStandalone);
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));

    const onBIP = (e: Event) => {
      e.preventDefault(); // 브라우저 기본 미니 배너 대신 우리 버튼으로 유도
      setPrompt(e as BIPEvent);
    };
    const onInstalled = () => { setStandalone(true); setShowHelp(false); };
    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (standalone || dismissed) return null;

  const onClick = async () => {
    if (prompt) {
      await prompt.prompt();
      await prompt.userChoice.catch(() => {});
      setPrompt(null);
      return;
    }
    setShowHelp((v) => !v); // 이벤트 없는 환경 → 수동 안내 토글
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-w-[min(20rem,calc(100vw-2rem))] flex-col items-end gap-2">
      {showHelp && !prompt && (
        <div className="rounded-xl border border-zinc-200 bg-white p-3 text-xs leading-relaxed text-zinc-700 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          <div className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">홈 화면에 앱으로 추가</div>
          {isIOS ? (
            <p>Safari 하단 <b>공유</b> 버튼(□↑) → <b>홈 화면에 추가</b>를 누르세요.</p>
          ) : (
            <p>브라우저 메뉴 <b>⋮</b>(우측 상단) → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 누르세요. 데스크톱 Chrome/Edge는 주소창 오른쪽의 <b>설치 아이콘(⊕)</b>을 누르면 됩니다.</p>
          )}
          <p className="mt-1 text-[11px] text-zinc-400">설치 버튼이 안 보이면 페이지를 새로고침해 보세요.</p>
        </div>
      )}
      <div className="flex items-center gap-1 rounded-full bg-sky-600 text-white shadow-lg ring-1 ring-sky-400/40">
        <button
          onClick={onClick}
          className="flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition hover:bg-sky-500 active:scale-95"
          aria-label="앱 설치"
        >
          <span aria-hidden>📲</span> 앱 설치
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="py-2.5 pl-1 pr-3 text-sm text-white/70 hover:text-white"
          aria-label="닫기"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
