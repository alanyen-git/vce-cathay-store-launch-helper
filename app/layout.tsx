import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VCE 國泰開店小幫手｜資產與開店專案管理",
  description: "VCE 國泰版：以手機優先的方式建立固定資產、門市與開店專案資料。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant-TW">
      <body className="antialiased">{children}</body>
    </html>
  );
}
