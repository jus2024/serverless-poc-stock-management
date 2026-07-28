import type { Metadata } from "next";
import { Inter } from "next/font/google";
import AmplifyProvider from "@/src/lib/amplify/AmplifyProvider";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Kiro Roasters 在庫管理システム",
  description: "DynamoDB のキー設計とスロットリングを検証するサーバーレス PoC",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className={inter.className}>
        <AmplifyProvider>{children}</AmplifyProvider>
      </body>
    </html>
  );
}
