"use client";

/**
 * A chain › token dropdown: each choice shows the token's logo with its
 * chain's logo in the corner. Search matches symbol and chain; the side
 * column narrows to one chain. Ported from the payments app's picker.
 */

import Image from "next/image";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { chainName, tokenLogo } from "@/lib/assetLogos";
import { useChainLogoSrc } from "@/components/ChainLogo";
import type { SwapAsset } from "@/lib/swap";

/** A logo, or the name's first letters in a disc when there is none or it fails to load. */
function Mark({
  src,
  name,
  size,
  className,
}: {
  src?: string;
  name: string;
  size: number;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const box = cn("shrink-0 rounded-full", className);
  if (!src || failed === src)
    return (
      <span
        aria-hidden
        className={cn(
          box,
          "inline-flex items-center justify-center bg-muted font-mono font-medium text-muted-foreground",
        )}
        style={{ width: size, height: size, fontSize: size * 0.38 }}
      >
        {name
          .replace(/[^A-Za-z0-9]/g, "")
          .slice(0, 2)
          .toUpperCase()}
      </span>
    );
  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      unoptimized
      className={cn(box, "object-cover")}
      onError={() => setFailed(src)}
    />
  );
}

function ChainMark({ network, size }: { network: string; size: number }) {
  const src = useChainLogoSrc(network);
  return <Mark src={src} name={chainName(network)} size={size} />;
}

/** The token's mark with its chain's mark in the lower right corner. */
export function TokenMark({
  asset,
  size = 28,
}: {
  asset: SwapAsset;
  size?: number;
}) {
  const badge = Math.round(size * 0.48);
  const chainSrc = useChainLogoSrc(asset.network);
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
      title={`${asset.ticker} on ${chainName(asset.network)}`}
    >
      <Mark src={tokenLogo(asset.ticker)} name={asset.ticker} size={size} />
      <Mark
        src={chainSrc}
        name={chainName(asset.network)}
        size={badge}
        className="absolute -right-1 -bottom-1 ring-2 ring-card"
      />
    </span>
  );
}

export function AssetPicker({
  label,
  items,
  value,
  onChange,
  placeholder = "Select token",
  disabled,
  align = "start",
}: {
  /** the trigger's accessible name */
  label: string;
  items: readonly SwapAsset[];
  /** the picked asset's key, or "" */
  value: string;
  onChange: (key: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** which edge of the trigger the menu lines up with */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chain, setChain] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const picked = items.find((a) => a.key === value);
  const chains = useMemo(
    () => [...new Set(items.map((a) => a.network))],
    [items],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = items.filter(
      (a) =>
        (!chain || a.network === chain) &&
        (!q ||
          a.ticker.toLowerCase().includes(q) ||
          a.network.toLowerCase().includes(q) ||
          chainName(a.network).toLowerCase().includes(q)),
    );
    // grouped by chain, chains in the order the venue lists them
    return chains.flatMap((n) => hit.filter((a) => a.network === n));
  }, [items, chains, chain, query]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const show = () => {
    setQuery("");
    setChain(null);
    setActive(
      Math.max(
        items.findIndex((a) => a.key === value),
        0,
      ),
    );
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const pick = (a: SwapAsset) => {
    onChange(a.key);
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => Math.min(Math.max(a + step, 0), shown.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = shown[active];
      if (a) pick(a);
    }
  };
  const narrow = (n: string | null) => {
    setChain(n);
    setActive(0);
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        className="flex items-center gap-2 rounded-full border border-border bg-background/60 py-1 pr-2.5 pl-1 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50 cursor-pointer"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        {picked ? (
          <>
            <TokenMark asset={picked} size={26} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="font-semibold">{picked.ticker}</span>
              <span className="truncate text-[10px] text-muted-foreground">
                {chainName(picked.network)}
              </span>
            </span>
          </>
        ) : (
          <>
            <span
              aria-hidden
              className="size-[26px] shrink-0 rounded-full border border-dashed border-border"
            />
            <span className="text-muted-foreground">{placeholder}</span>
          </>
        )}
        <ChevronDown className="ml-1 size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute z-30 mt-2 flex w-[min(30rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl",
            align === "end" ? "right-0" : "left-0",
          )}
          onKeyDown={onKey}
        >
          <input
            autoFocus
            className="border-b border-border bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search token or chain"
            aria-label="Search token or chain"
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={
              shown[active] ? `${id}-${active}` : undefined
            }
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <div className="flex max-h-80 min-h-0">
            {chains.length > 1 && (
              <div
                className="hidden w-40 shrink-0 flex-col overflow-y-auto border-r border-border py-1 sm:flex"
                aria-label="Chains"
              >
                <ChainButton on={!chain} onClick={() => narrow(null)}>
                  <span
                    aria-hidden
                    className="inline-grid size-[18px] shrink-0 grid-cols-2 gap-px"
                  >
                    {[0, 1, 2, 3].map((k) => (
                      <span key={k} className="rounded-full bg-muted" />
                    ))}
                  </span>
                  All chains
                </ChainButton>
                {chains.map((n) => (
                  <ChainButton
                    key={n}
                    on={chain === n}
                    onClick={() => narrow(n)}
                  >
                    <ChainMark network={n} size={18} />
                    <span className="truncate">{chainName(n)}</span>
                  </ChainButton>
                ))}
              </div>
            )}
            <div
              ref={list}
              id={`${id}-list`}
              role="listbox"
              aria-label={label}
              className="min-w-0 flex-1 overflow-y-auto py-1"
            >
              {shown.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No token matches.
                </p>
              )}
              {shown.map((a, n) => {
                const head = n === 0 || shown[n - 1]!.network !== a.network;
                const on = a.key === value;
                return (
                  <div key={a.key}>
                    {head && !chain && (
                      <div className="px-3 pt-2.5 pb-1 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                        {chainName(a.network)}
                      </div>
                    )}
                    <div
                      id={`${id}-${n}`}
                      data-index={n}
                      role="option"
                      aria-selected={on}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm",
                        n === active && "bg-accent",
                      )}
                      onMouseMove={() => setActive(n)}
                      onClick={() => pick(a)}
                    >
                      <TokenMark asset={a} size={30} />
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="font-medium">{a.ticker}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {chainName(a.network)}
                        </span>
                      </span>
                      {on && (
                        <Check className="ml-auto size-4 shrink-0 text-primary" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChainButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-pressed={on}
      className={cn(
        "flex items-center gap-2 border-l-2 px-3 py-1.5 text-left text-sm cursor-pointer",
        on
          ? "border-primary bg-accent text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
