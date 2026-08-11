import "@/styles/globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { parseRpcUrlMap } from "@aspens/terminal-sdk";
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

/**
 * The root layout reads `EXT_PROXY_URL` at REQUEST time, so it must not be
 * prerendered.
 *
 * Without this the shell is statically generated at BUILD time, when the var
 * does not exist, and `fceEnabled: false` is baked into the RSC payload —
 * shipping a UI that ignores its own runtime configuration and calls arborter
 * gRPC anyway. That is the same build-time-env footgun `next.config.ts`
 * documents for the envoy upstream, and it fails SILENTLY: the page renders,
 * and only the data calls fail.
 *
 * Cost is nil here — this is a live trading terminal whose every view is
 * request-scoped, so there was no meaningful static shell to keep.
 */
export const dynamic = "force-dynamic";

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
  // `CHAIN_RPC_URLS` DOES cross into the client tree, deliberately: the
  // browser reads token/trade-contract balances directly and the arborter
  // masks `rpc_url` in GetConfig, so without this every balance is skipped.
  // Public endpoints only — see `lib/providers/rpc-context.tsx`.
  const rpcUrls = parseRpcUrlMap(process.env.CHAIN_RPC_URLS);
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
        <Providers fceEnabled={fceEnabled} rpcUrls={rpcUrls}>
          {children}
        </Providers>
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
