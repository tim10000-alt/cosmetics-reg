"use client";

import { useEffect, useState } from "react";

// 설치 가능 시점에 beforeinstallprompt 이벤트가 온다(Android Chrome·데스크톱 Chrome/Edge).
// ⚠️ 이 이벤트는 페이지 로드 극초기에 발생 → React hydration 후 리스너를 붙이면 놓친다(레이스).
// 그래서 layout 의 인라인 스크립트가 *HTML 파싱 시점에* 먼저 캡처해 window.__bip 에 저장하고
// 'bip-ready' 이벤트를 쏜다. 이 컴포넌트는 그 값을 읽어 '앱 설치' 버튼이 실제 네이티브 설치창을
// 확실히 띄우게 한다(놓쳐서 안내문만 뜨던 문제 수정).
type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
declare global {
  interface Window { __bip?: BIPEvent | null }
}

export default function InstallButton() {
  const [prompt, setPrompt] = useState<BIPEvent | null>(null);
  const [standalone, setStandalone] = useState(true); // SSR 안전: 기본 숨김 → 마운트 후 판정
  const [showHelp, setShowHelp] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const inStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setStandalone(!!inStandalone);
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));

    // 이미 인라인 스크립트가 캡처해 둔 이벤트가 있으면 즉시 사용.
    if (window.__bip) setPrompt(window.__bip);
    const onReady = () => { if (window.__bip) setPrompt(window.__bip); };
    // 인라인 스크립트가 없거나 늦은 경우 대비, 직접 리스너도 둔다(중복 안전).
    const onBIP = (e: Event) => { e.preventDefault(); window.__bip = e as BIPEvent; setPrompt(e as BIPEvent); };
    const onInstalled = () => { window.__bip = null; setStandalone(true); setShowHelp(false); };
    window.addEventListener("bip-ready", onReady);
    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("bip-ready", onReady);
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (standalone || dismissed) return null;

  const onClick = async () => {
    const ev = prompt || window.__bip;
    if (ev) {
      try {
        await ev.prompt();
        await ev.userChoice.catch(() => {});
      } catch {
        // 이미 소비된 이벤트 등 → 안내로 폴백
        setShowHelp(true);
      }
      window.__bip = null;
      setPrompt(null);
      return;
    }
    setShowHelp((v) => !v); // 이벤트 없는 환경 → 수동 안내 토글
  };

  const installable = !!(prompt);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-w-[min(20rem,calc(100vw-2rem))] flex-col items-end gap-2">
      {showHelp && !installable && (
        <div className="rounded-xl border border-zinc-200 bg-white p-3 text-xs leading-relaxed text-zinc-700 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          <div className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">홈 화면에 앱으로 추가</div>
          {isIOS ? (
            <p>Safari 하단 <b>공유</b> 버튼(□↑) → <b>홈 화면에 추가</b>를 누르세요.</p>
          ) : (
            <p>브라우저 메뉴 <b>⋮</b>(우측 상단) → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 누르세요. 데스크톱 Chrome/Edge는 주소창 오른쪽의 <b>설치 아이콘(⊕)</b>을 누르면 됩니다.</p>
          )}
          <p className="mt-1 text-[11px] text-zinc-400">버튼이 회색이면 잠시 후(또는 새로고침 후) 자동 설치가 가능해집니다.</p>
        </div>
      )}
      <div className={`flex items-center gap-1 rounded-full text-white shadow-lg ring-1 ${installable ? "bg-sky-600 ring-sky-400/40" : "bg-zinc-500 ring-zinc-400/40"}`}>
        <button
          onClick={onClick}
          className="flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition hover:brightness-110 active:scale-95"
          aria-label="앱 설치"
          title={installable ? "앱 설치" : "설치 방법 보기"}
        >
          <span aria-hidden>📲</span> 앱 설치{installable ? "" : " 안내"}
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
