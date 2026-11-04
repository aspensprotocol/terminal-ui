"use client";

import { useEffect } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { SwapPanel } from "@/components/swap/SwapPanel";

export default function SwapPage() {
  useEffect(() => {
    document.title = "Aspens - Swap";
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground p-4 dither-strong">
      <div className="max-w-[2000px] mx-auto">
        <SiteHeader />
        <div className="pt-4 md:pt-12">
          <SwapPanel />
        </div>
      </div>
    </main>
  );
}
