"use client";

import { useEffect, useState } from "react";

type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
declare global {
  interface Window { __bip?: BIPEvent | null }
}

type Env = {
  ua: string;
  https: boolean;
  iOS: boolean;
  inApp: boolean;     // 카카오/네이버/인스타 등 인앱 브라우저(WebView) — PWA 설치 불가
  samsung: boolean;
  chrome: boolean;
  sw: boolean;
  standalone: boolean;
};

function detect(): Env {
  const ua = navigator.userAgent;
  const iOS = /iphone|ipad|ipod/i.test(ua);
  // 인앱 브라우저 표식 — 카카오/네이버/인스타/페북/라인/다음 + Android WebView "; wv)"
  const inApp = /KAKAOTALK|NAVER\(|NAVER |inapp|Instagram|FBAN|FBAV|FB_IAB|Line\/|Daum|DaumApps|; wv\)|\bwv\b/i.test(ua);
  const samsung = /SamsungBrowser/i.test(ua);
  const chrome = /Chrome\//i.test(ua) && !inApp;
  const standalone =
    (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches) ||
    (typeof navigator !== "undefined" && (navigator as unknown as { standalone?: boolean }).standalone === true);
  return { ua, https: location.protocol === "https:", iOS, inApp, samsung, chrome, sw: "serviceWorker" in navigator, standalone: !!standalone };
}

export default function InstallButton() {
  const [prompt, setPrompt] = useState<BIPEvent | null>(null);
  const [env, setEnv] = useState<Env | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [swReady, setSwReady] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setEnv(detect());
    if (window.__bip) setPrompt(window.__bip);
    navigator.serviceWorker?.getRegistration?.().then((r) => setSwReady(!!(r && r.active))).catch(() => {});
    const onReady = () => { if (window.__bip) setPrompt(window.__bip); };
    const onBIP = (e: Event) => { e.preventDefault(); window.__bip = e as BIPEvent; setPrompt(e as BIPEvent); };
    const onInstalled = () => { window.__bip = null; setPrompt(null); setEnv(detect()); };
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

  if (!env || env.standalone || dismissed) return null;

  const installable = !!prompt;

  const doInstall = async () => {
    const ev = prompt || window.__bip;
    if (ev) {
      try { await ev.prompt(); await ev.userChoice.catch(() => {}); }
      catch { setOpen(true); }
      window.__bip = null; setPrompt(null);
      return;
    }
    setOpen((v) => !v);
  };

  // 상황별 핵심 안내 1줄.
  const guide = env.inApp
    ? "⚠ 지금은 앱 속 브라우저(카카오·네이버 등)예요. 여기선 설치가 안 됩니다. 우측 위 ⋮ → ‘다른 브라우저로 열기(Chrome)’ 로 연 뒤 설치하세요."
    : env.iOS
    ? "아이폰: Safari 하단 공유(□↑) → ‘홈 화면에 추가’."
    : installable
    ? "‘앱 설치’를 누르면 설치창이 떠요."
    : env.chrome || env.samsung
    ? "브라우저 메뉴 ⋮ → ‘앱 설치’ 또는 ‘홈 화면에 추가’. (데스크톱은 주소창 오른쪽 설치 아이콘 ⊕) 안 보이면 새로고침 후 잠시 기다리세요."
    : "이 브라우저는 설치를 지원하지 않을 수 있어요. Chrome 또는 삼성인터넷으로 이 주소를 열어 설치하세요.";

  const yn = (b: boolean) => (b ? "✓" : "✗");
  const browserName = env.inApp ? "인앱 브라우저" : env.iOS ? "iOS Safari" : env.samsung ? "삼성인터넷" : env.chrome ? "Chrome" : "기타";

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-w-[min(22rem,calc(100vw-2rem))] flex-col items-end gap-2">
      {open && (
        <div className="rounded-xl border border-zinc-200 bg-white p-3 text-xs leading-relaxed text-zinc-700 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          <div className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">앱 설치 진단</div>
          <p className={env.inApp ? "font-medium text-amber-700 dark:text-amber-300" : ""}>{guide}</p>
          <ul className="mt-2 space-y-0.5 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <li>브라우저: <b>{browserName}</b></li>
            <li>HTTPS: {yn(env.https)} · 서비스워커: {yn(env.sw && swReady)}</li>
            <li>설치 이벤트 감지: {yn(installable)} {(!installable && (env.chrome || env.samsung)) ? "(메뉴로 설치 가능)" : ""}</li>
            <li>이미 설치됨: {yn(env.standalone)}</li>
          </ul>
        </div>
      )}
      <div className={`flex items-center gap-1 rounded-full text-white shadow-lg ring-1 ${env.inApp ? "bg-amber-600 ring-amber-400/40" : installable ? "bg-sky-600 ring-sky-400/40" : "bg-zinc-500 ring-zinc-400/40"}`}>
        <button
          onClick={doInstall}
          className="flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition hover:brightness-110 active:scale-95"
          aria-label="앱 설치"
        >
          <span aria-hidden>📲</span> {env.inApp ? "설치 방법" : installable ? "앱 설치" : "앱 설치 방법"}
        </button>
        <button onClick={() => setDismissed(true)} className="py-2.5 pl-1 pr-3 text-sm text-white/70 hover:text-white" aria-label="닫기">✕</button>
      </div>
    </div>
  );
}
