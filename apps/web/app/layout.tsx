import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import "./globals.css";
import { Overlays } from "@/components/overlays";

// Shipped with the app (SIL Open Font License, see app/fonts): building needs no
// network and pages never fetch fonts from Google.
const inter = localFont({ src: "./fonts/inter-latin-wght.woff2", weight: "100 900", variable: "--font-inter", display: "swap" });
const mono = localFont({ src: "./fonts/jetbrains-mono-latin-wght.woff2", weight: "100 800", variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Zerobeat", template: "%s · Zerobeat" },
  description: "Your rig, every digital mode, any browser",
  applicationName: "Zerobeat",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: { title: "Zerobeat", description: "Your rig, every digital mode, any browser", images: ["/card.png"] },
  appleWebApp: { capable: true, title: "Zerobeat", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = { themeColor: "#0a0c10", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        {children}
        <Overlays />
      </body>
    </html>
  );
}
