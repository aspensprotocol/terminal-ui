import { formatNumber } from "@exchange/sdk";

interface AvailableBalanceProps {
  side: "buy" | "sell";
  availableBase: number;
  availableQuote: number;
  baseToken: { ticker: string };
  quoteToken: { ticker: string };
  isAuthenticated: boolean;
  onFaucetClick: () => void;
}

export function AvailableBalance({
  side,
  availableBase,
  availableQuote,
  baseToken,
  quoteToken,
  isAuthenticated,
  onFaucetClick,
}: AvailableBalanceProps) {
  const balance = side === "buy" ? availableQuote : availableBase;
  const ticker = side === "buy" ? quoteToken.ticker : baseToken.ticker;

  return (
    <button
      type="button"
      onClick={() => isAuthenticated && onFaucetClick()}
      className="under text-[10px] text-muted-foreground/60 hover:text-primary/70 transition-colors cursor-pointer w-full -mt-1 flex justify-between items-center py-1"
      disabled={!isAuthenticated}
    >
      <span className="opacity-70 underline-offset-2 underline decoration-dotted">Available:</span>
      <span className="font-medium">
        {isAuthenticated ? formatNumber(balance, 4) : "0.00"} {ticker}
      </span>
    </button>
  );
}
