"use client";

import { useEffect, useState } from "react";

// 설치 가능 시점에 beforeinstallprompt 이벤트가 온다(Android Chrome·데스크톱 Chrome/Edge).
type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// 눈에 보이는 "앱 설치" 버튼 — 브라우저 메뉴를 안 찾아도 한 번에 설치.
// 이미 설치(standalone)거나 설치 불가 브라우저면 아무것도 렌더하지 않는다.
export default function InstallButton() {
  const [prompt, setPrompt] = useState<BIPEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // 이미 설치되어 standalone 으로 실행 중이면 버튼 숨김.
    if (window.matchMedia?.("(display-mode: standalone)").matches) return;

    const onBIP = (e: Event) => {
      e.preventDefault(); // 브라우저 기본 미니 배너 대신 우리 버튼으로 유도
      setPrompt(e as BIPEvent);
    };
    const onInstalled = () => setPrompt(null);

    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!prompt || dismissed) return null;

  const install = async () => {
    await prompt.prompt();
    await prompt.userChoice.catch(() => {});
    setPrompt(null); // 한 번 쓰면 이벤트는 재사용 불가
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full bg-sky-600 text-white shadow-lg ring-1 ring-sky-400/40">
      <button
        onClick={install}
        className="flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold hover:bg-sky-500 active:scale-95 transition"
        aria-label="앱 설치"
      >
        <span aria-hidden>📲</span> 앱 설치
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="pr-3 pl-1 py-2.5 text-white/70 hover:text-white text-sm"
        aria-label="닫기"
      >
        ✕
      </button>
    </div>
  );
}
