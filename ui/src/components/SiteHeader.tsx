"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { WalletManager } from "@/components/WalletManager";
import { TransferDialog } from "@/components/TransferDialog";

const TABS = [
  { href: "/", label: "Trade" },
  { href: "/swap", label: "Swap" },
];

/** Logo, page tabs, and the transfer/wallet actions — shared by every page. */
export function SiteHeader() {
  const pathname = usePathname();
  return (
    <div className="mb-4 md:mb-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          {/* Logo — links to the site home ('/'), not the source repo. */}
          <Link
            href="/"
            className="flex items-center gap-3 group select-none cursor-pointer"
          >
            <Image
              src="/logo3.png"
              alt="Exchange Logo"
              width={48}
              height={48}
              className="h-12 w-12 transition-all duration-200 group-hover:brightness-120"
              priority
            />
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {TABS.map((t) => {
              const active = pathname === t.href;
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 font-medium transition-colors",
                    active
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <TransferDialog />
          <WalletManager />
        </div>
      </div>
    </div>
  );
}
