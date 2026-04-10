import { Button } from "@/components/ui/button";
import type { Token } from "@/lib/types/exchange";
import type { ChainEcosystem } from "@/lib/wallet/types";

type OrderSide = "buy" | "sell";

interface SubmitButtonProps {
  side: OrderSide;
  baseToken: Token;
  isAuthenticated: boolean;
  loading: boolean;
  /**
   * If set, the selected market needs this ecosystem but no connected wallet matches.
   * The button becomes a connect-wallet CTA instead of a submit button.
   */
  missingEcosystem?: ChainEcosystem | null;
  onConnectMissing?: () => void;
}

export function SubmitButton({
  side,
  baseToken,
  isAuthenticated,
  loading,
  missingEcosystem,
  onConnectMissing,
}: SubmitButtonProps) {
  // Missing-wallet CTA takes precedence over the normal submit flow.
  if (isAuthenticated && missingEcosystem) {
    const label =
      missingEcosystem === "solana"
        ? "Connect Solana Wallet"
        : "Connect EVM Wallet";
    return (
      <Button
        type="button"
        onClick={onConnectMissing}
        size="default"
        className="w-full font-semibold text-sm h-10 transition-all bg-primary hover:bg-primary/90 text-primary-foreground"
      >
        {label}
      </Button>
    );
  }

  const getButtonText = () => {
    if (loading) return "Placing Order...";
    if (!isAuthenticated) return "Connect Wallet";
    return `${side === "buy" ? "Buy" : "Sell"} ${baseToken.ticker}`;
  };

  return (
    <Button
      type="submit"
      disabled={loading || !isAuthenticated}
      size="default"
      className={`w-full font-semibold text-sm h-10 transition-all ${
        side === "buy"
          ? "bg-green-600 hover:bg-green-700 text-white"
          : "bg-red-600 hover:bg-red-700 text-white"
      }`}
    >
      {getButtonText()}
    </Button>
  );
}
