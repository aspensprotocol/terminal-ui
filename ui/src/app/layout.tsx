import "@/styles/globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { Providers } from "@/lib/providers";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Aspens",
  description: "Trading exchange application",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Server Component: `EXT_PROXY_URL` is read here and NEVER forwarded. Only
  // the boolean crosses into the client tree — the URL and `DIRECT_API_KEY`
  // stay server-side, reachable solely through the /fce-proxy relay.
  const fceEnabled = Boolean(process.env.EXT_PROXY_URL);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script
          src="/vendor/trading-view/charting_library.standalone.js"
          strategy="beforeInteractive"
        />
      </head>
      <body
        className={`${geistSans.className} ${geistMono.className} font-sans antialiased`}
      >
        <Providers fceEnabled={fceEnabled}>{children}</Providers>
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
