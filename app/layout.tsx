import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import RegisterSW from "./register-sw";
import InstallButton from "./install-button";
import { BASE_PATH } from "@/lib/base-path";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://tim10000-alt.github.io/cosmetics-reg";
const TITLE = "화장품 원료 규제 검색";
const DESC = "19개국 화장품 원료의 배합금지·한도·positive list 수록 여부를 식약처 공공데이터 API 등 공식 기관 원본에서 직접 조회.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESC,
  openGraph: {
    title: TITLE,
    description: DESC,
    url: SITE_URL,
    siteName: TITLE,
    locale: "ko_KR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESC,
  },
  robots: { index: true, follow: true },
  appleWebApp: {
    capable: true,
    title: "규제검색",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: `${BASE_PATH}/icons/icon-192.png`,
    apple: `${BASE_PATH}/icons/apple-touch-icon.png`,
  },
};

export const viewport: Viewport = {
  themeColor: "#0b1020",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* 테마 무깜빡임 초기화 — 저장된 선택(localStorage.theme) 우선, 없으면 시스템 설정.
            paint 전에 <html>.dark 를 설정해야 라이트→다크 플래시가 안 생긴다. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}",
          }}
        />
        {/* beforeinstallprompt 를 React hydration 전에 캡처(레이스 방지) — '앱 설치' 버튼이
            실제 네이티브 설치창을 확실히 띄우게. 안 하면 이벤트를 놓쳐 설치 안 되고 아이콘도 안 생김. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__bip=e;window.dispatchEvent(new Event('bip-ready'));});window.addEventListener('appinstalled',function(){window.__bip=null;});",
          }}
        />
        <RegisterSW />
        <InstallButton />
        {children}
      </body>
    </html>
  );
}
