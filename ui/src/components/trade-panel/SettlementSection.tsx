"use client";

/**
 * Where this order settles, per chain leg — and the controls to change it.
 *
 * An order carries one account address per chain leg, and the venue
 * credits fill proceeds to those exact strings. The GIVING leg (buy →
 * quote, sell → base) is the signing wallet by construction — the venue
 * verifies the envelope signature against it — so it renders read-only.
 * The RECEIVING leg defaults to the connected wallet on that chain and can
 * be redirected to any well-formed address there ("settle to a different
 * address"), behind an explicit per-order acknowledgement: the venue has
 * no address registry, so nothing can check anyone holds the redirected
 * address's key, and funds credited there are withdrawable only by that
 * key's holder.
 *
 * Two acknowledgement surfaces live here:
 * - Redirect ack: per order, never persisted (`settleRedirectAck`).
 * - EVM/EVM same-address ack: the single-wallet default settles BOTH legs
 *   to one address; asked once per wallet, then remembered
 *   (`lib/settlement-ack.ts`) and shown as a passive note.
 *
 * Controls that don't apply are NOT rendered disabled — a disabled toggle
 * would imply the choice exists here and is merely unavailable. On FCE
 * deployments the redirect option is absent entirely (that transport
 * derives both addresses from the wallets and would silently drop an
 * override); on a market whose receiving chain has no connected wallet,
 * the address input is simply mandatory, with no toggle.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { UseFormSetValue } from "react-hook-form";
import { sameSettleAddress, validateSettleAddress } from "@aspens/terminal-sdk";
import { useExchangeStore } from "@/lib/store";
import { settlementWallets, sideLegs } from "@/lib/wallet";
import { hasSameAddressAck } from "@/lib/settlement-ack";
import { shortenAddress } from "@/lib/utils";
import { ChainLogo } from "@/components/ChainLogo";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useFceEnabled } from "@/lib/providers/fce-context";
import type { Market } from "@/lib/types/exchange";
import type { TradeFormData } from "./types";

interface SettlementSectionProps {
  market: Market;
  side: TradeFormData["side"];
  settleToDifferent: boolean;
  settleAddress: string;
  settleRedirectAck: boolean;
  sameAddressAck: boolean;
  setValue: UseFormSetValue<TradeFormData>;
}

export function SettlementSection({
  market,
  side,
  settleToDifferent,
  settleAddress,
  settleRedirectAck,
  sameAddressAck,
  setValue,
}: SettlementSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const fceEnabled = useFceEnabled();
  const connectedWallets = useExchangeStore((state) => state.connectedWallets);
  const activeWalletId = useExchangeStore((state) => state.activeWalletId);

  const legs = sideLegs(market, side);
  const giveIsBase = legs.givingLeg === "base";
  const giveNetwork = giveIsBase
    ? market.baseChainNetwork
    : market.quoteChainNetwork;
  const receiveNetwork = giveIsBase
    ? market.quoteChainNetwork
    : market.baseChainNetwork;
  const giveArch =
    (giveIsBase
      ? market.baseChainArchitecture
      : market.quoteChainArchitecture) ?? "";
  const receiveArch =
    (giveIsBase
      ? market.quoteChainArchitecture
      : market.baseChainArchitecture) ?? "";

  // ONE selection, shared with the submit hook (`settlementWallets`):
  // what this section shows must be what gets signed, so neither side
  // carries its own preference order.
  const { signingWallet, receivingWallet } = settlementWallets(
    connectedWallets,
    activeWalletId,
    legs,
  );

  // No toggle without a wallet to toggle back to: the address is mandatory.
  const addressIsMandatory = receivingWallet === null;
  const overrideActive =
    !fceEnabled && (addressIsMandatory || settleToDifferent);

  const trimmedOverride = settleAddress.trim();
  const overrideError =
    overrideActive && trimmedOverride !== ""
      ? validateSettleAddress(receiveArch, trimmedOverride)
      : null;

  // A redirect = an override that names something OTHER than the wallet the
  // leg would default to. Restating the connected wallet is not a redirect.
  const isRedirect =
    overrideActive &&
    trimmedOverride !== "" &&
    overrideError === null &&
    (receivingWallet === null ||
      !sameSettleAddress(
        receiveArch,
        trimmedOverride,
        receivingWallet.address,
      ));

  const receiveAddress = overrideActive
    ? trimmedOverride
    : (receivingWallet?.address ?? "");

  // The EVM/EVM single-address default: both legs hex, same string.
  const isSolanaArch = (a: string) => a.toLowerCase() === "solana";
  const sameAddressDefault =
    signingWallet !== null &&
    !isRedirect &&
    !isSolanaArch(giveArch) &&
    !isSolanaArch(receiveArch) &&
    receiveAddress !== "" &&
    sameSettleAddress("evm", signingWallet.address, receiveAddress);
  const sameAddressAlreadyAcked =
    signingWallet !== null && hasSameAddressAck(signingWallet.address);

  // Keyed by leg role, not network — a single-chain market has the same
  // network on both legs, which would collide as a React key.
  const summary = [
    {
      leg: "give",
      network: giveNetwork,
      address: signingWallet?.address ?? "—",
    },
    { leg: "receive", network: receiveNetwork, address: receiveAddress || "—" },
  ];

  return (
    <div className="rounded-md border border-border/40">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 text-sm"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1 text-muted-foreground">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Settlement
        </span>
        {!expanded && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {summary.map(({ leg, network, address }) => (
              <span key={leg} className="flex items-center gap-1">
                <ChainLogo network={network} />
                <span title={address}>
                  {address === "—" ? "—" : shortenAddress(address)}
                </span>
              </span>
            ))}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 text-xs">
          {/* Giving leg — the signer, read-only. */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <ChainLogo network={giveNetwork} />
              <span className="font-medium">
                {side === "buy" ? "Pay" : "Sell"} on {giveNetwork}
              </span>
              <span className="ml-auto">signs this order</span>
            </div>
            <p className="font-mono break-all">
              {signingWallet?.address ?? "no wallet connected for this chain"}
            </p>
          </div>

          {/* Receiving leg — where proceeds settle. */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <ChainLogo network={receiveNetwork} />
              <span className="font-medium">Receive on {receiveNetwork}</span>
            </div>

            {fceEnabled ? (
              <p className="font-mono break-all">
                {receiveAddress ||
                  `connect a ${receiveNetwork} wallet to receive`}
                <span className="block font-sans text-muted-foreground mt-0.5">
                  Proceeds settle to this connected wallet. Choosing a different
                  address isn&apos;t available on this deployment&apos;s
                  transport.
                </span>
              </p>
            ) : (
              <>
                {!addressIsMandatory && (
                  <div className="flex items-center gap-2">
                    <input
                      id="settle-different"
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={settleToDifferent}
                      onChange={(e) => {
                        setValue("settleToDifferent", e.target.checked);
                        if (!e.target.checked) {
                          setValue("settleRedirectAck", false);
                        }
                      }}
                    />
                    <Label
                      htmlFor="settle-different"
                      className="text-xs font-medium cursor-pointer"
                    >
                      Settle to a different address
                    </Label>
                  </div>
                )}

                {overrideActive ? (
                  <>
                    <Input
                      id="settle-address"
                      placeholder={
                        isSolanaArch(receiveArch)
                          ? "Solana address (base58)"
                          : "0x…"
                      }
                      value={settleAddress}
                      onChange={(e) => {
                        setValue("settleAddress", e.target.value);
                        // The redirect ack is per ADDRESS as much as per
                        // order — a box checked for one address must not
                        // stand for the next one typed over it.
                        setValue("settleRedirectAck", false);
                      }}
                      className="font-mono text-xs"
                    />
                    {addressIsMandatory && (
                      <p className="text-muted-foreground">
                        No {receiveNetwork} wallet is connected — enter the
                        address your proceeds should settle to.
                      </p>
                    )}
                    {overrideError !== null && (
                      <p className="text-red-500">{overrideError}</p>
                    )}
                  </>
                ) : (
                  <p className="font-mono break-all">{receiveAddress || "—"}</p>
                )}
              </>
            )}
          </div>

          {/* Redirect acknowledgement — per order, never remembered. */}
          {isRedirect && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-1">
              <div className="flex items-center gap-2">
                <input
                  id="settle-redirect-ack"
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={settleRedirectAck}
                  onChange={(e) =>
                    setValue("settleRedirectAck", e.target.checked)
                  }
                />
                <Label
                  htmlFor="settle-redirect-ack"
                  className="text-xs font-medium cursor-pointer"
                >
                  Settle proceeds to {shortenAddress(trimmedOverride)}
                </Label>
              </div>
              <p className="text-muted-foreground">
                Fills from this order are credited to that address. Nothing can
                verify anyone holds its key — funds credited there are
                withdrawable ONLY by that key&apos;s holder, and this order
                won&apos;t appear under your own address in history filters.
              </p>
            </div>
          )}

          {/* EVM/EVM same-address acknowledgement — once per wallet. */}
          {sameAddressDefault &&
            (sameAddressAlreadyAcked ? (
              <p className="text-muted-foreground">
                Both legs settle to this wallet&apos;s address — the same
                address on both chains.
              </p>
            ) : (
              <div className="rounded-md border border-border/40 bg-background/40 px-3 py-2 space-y-1">
                <div className="flex items-center gap-2">
                  <input
                    id="settle-same-ack"
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={sameAddressAck}
                    onChange={(e) =>
                      setValue("sameAddressAck", e.target.checked)
                    }
                  />
                  <Label
                    htmlFor="settle-same-ack"
                    className="text-xs font-medium cursor-pointer"
                  >
                    Use the same address on both chains
                  </Label>
                </div>
                <p className="text-muted-foreground">
                  Both chains are EVM and this order settles BOTH legs to{" "}
                  {shortenAddress(receiveAddress)} — the one connected wallet.
                  Confirm it with your first order and it&apos;s remembered for
                  this wallet.
                </p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
