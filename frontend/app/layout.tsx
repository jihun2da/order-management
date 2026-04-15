import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "주문 관리 시스템",
  description: "담당자별 주문번호 생성 및 재고 관리",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="bg-gray-50 text-gray-900 min-h-screen">{children}</body>
    </html>
  );
}
