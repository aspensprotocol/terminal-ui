/**
 * Shared wallet-connection entry points.
 *
 * `openPicker` shows the unified picker dialog (optionally narrowed to one
 * ecosystem) and is what buttons outside the dialog call. `connectEvm` and
 * `connectSolana` are what the picker's rows call once the user has chosen a
 * provider; they drive wagmi and the Solana wallet-adapter directly.
 */

import { useCallback } from "react";
import { useConnect } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { useWalletPickerStore } from "@/lib/wallet/picker-store";

export function useWalletConnect() {
  const openPicker = useWalletPickerStore((s) => s.open);
  const { connectAsync, connectors } = useConnect();
  const { select } = useWallet();

  const connectEvm = useCallback(
    async (connectorId: string) => {
      const connector = connectors.find((c) => c.id === connectorId);
      if (!connector) {
        toast.error("That EVM wallet is no longer available");
        return;
      }
      try {
        await connectAsync({ connector });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A user closing the wallet's prompt is not an error worth shouting.
        if (!/rejected|denied|cancel/i.test(message)) {
          toast.error(`EVM connect failed: ${message}`);
        }
      }
    },
    [connectAsync, connectors],
  );

  // `WalletProvider` is mounted with `autoConnect`, so selecting a wallet the
  // user clicked connects it; a wallet that is not installed opens its
  // install page instead. The provider reports failures through its own
  // error handler and clears the selection, so nothing to catch here.
  const connectSolana = useCallback(
    (walletName: string) => {
      // `WalletName` is a branded string from a transitive package; derive
      // the type from `select` rather than import it.
      select(walletName as Parameters<typeof select>[0]);
    },
    [select],
  );

  return { openPicker, connectEvm, connectSolana };
}
