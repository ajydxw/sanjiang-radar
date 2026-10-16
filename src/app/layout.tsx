import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "三江雷达 · 今日校园机会",
  description: "面向三江学院2026级大一新生，整理学校官网通知、PU活动和已导入的公众号文章，保留官方来源、截止时间与参加条件。",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f7f8fa" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
