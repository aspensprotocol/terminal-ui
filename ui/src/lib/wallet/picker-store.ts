/**
 * Open/closed state of the unified wallet picker dialog.
 *
 * Lives outside the exchange store so any component — the header trigger,
 * the trade panel's "connect a wallet for this market" CTA — can open the
 * same dialog without threading callbacks. `ecosystem` narrows the picker to
 * one chain family; `null` shows every provider.
 */

import { create } from "zustand";
import type { ChainEcosystem } from "./types";

interface WalletPickerState {
  isOpen: boolean;
  ecosystem: ChainEcosystem | null;
  open: (ecosystem?: ChainEcosystem | null) => void;
  close: () => void;
}

export const useWalletPickerStore = create<WalletPickerState>((set) => ({
  isOpen: false,
  ecosystem: null,
  open: (ecosystem = null) => set({ isOpen: true, ecosystem }),
  close: () => set({ isOpen: false, ecosystem: null }),
}));
