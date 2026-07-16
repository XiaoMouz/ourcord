import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("host") ?? "ourcord.mou.best";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title: "OurCord — 朋友在线，数据在你手里",
    description: "面向 5–10 人小群体的自托管通讯工具。P2P 优先，WireGuard 覆盖网承载语音、文件与远程协作。",
    openGraph: {
      title: "OurCord — 朋友在线，数据在你手里",
      description: "P2P 优先的自托管小群通讯工具。",
      type: "website",
      images: [{ url: "/og.png", width: 1536, height: 1024, alt: "OurCord" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "OurCord — 朋友在线，数据在你手里",
      description: "P2P 优先的自托管小群通讯工具。",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
