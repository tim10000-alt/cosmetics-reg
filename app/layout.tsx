import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import RegisterSW from "./register-sw";
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
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
