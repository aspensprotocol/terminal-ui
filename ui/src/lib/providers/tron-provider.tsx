"use client";

/**
 * MetaMask's Tron account, for the venue's Tron chain.
 *
 * Creates the `@tronweb3/tronwallet-adapter-metamask-tron` adapter in the
 * browser only, hands it to the Tron wallet adapter (`setTronWallet`) and
 * exposes its connection state to the picker and the wallet sync.
 *
 * - A Tron leg is offered only when the venue's config lists a Tron chain;
 *   that chain's id is the one MetaMask is switched to. The library's
 *   `connect()` always opens a mainnet session, so on Nile the connect is
 *   followed by `switchChain`.
 * - The library base64-encodes messages with `Buffer`, which the browser
 *   lacks, so the polyfill is installed before the adapter loads.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { MetaMaskAdapter } from "@tronweb3/tronwallet-adapter-metamask-tron";
import { useExchangeStore } from "@/lib/store";
import {
  setTronWallet,
  tronChainIdForVenue,
  tronChainIdHex,
  type MetaMaskTronLike,
  type TronTransactionRequest,
} from "@/lib/wallet/tron-adapter";

export interface TronWalletState {
  /** The venue lists a Tron chain, so a Tron leg is offered. */
  available: boolean;
  /** MetaMask was detected on this page. */
  installed: boolean;
  icon?: string;
  /** The connected account in `T…` form, or `null`. */
  address: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const TronWalletContext = createContext<TronWalletState>({
  available: false,
  installed: false,
  address: null,
  connect: async () => {},
  disconnect: async () => {},
});

/** The library adapter, seen through the narrow interface the bridge uses. */
function bridge(adapter: MetaMaskAdapter): MetaMaskTronLike {
  return {
    get address() {
      return adapter.address;
    },
    signMessage: (message) => adapter.signMessage(message),
    signTransaction: (tx: TronTransactionRequest) =>
      adapter.signTransaction(
        tx as unknown as Parameters<MetaMaskAdapter["signTransaction"]>[0],
      ),
    network: () => adapter.network(),
    switchChain: (chainId) => adapter.switchChain(chainId),
    disconnect: () => adapter.disconnect(),
  };
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function TronProvider({ children }: { children: ReactNode }) {
  const config = useExchangeStore((s) => s.config);
  const chainIdHex = useMemo(() => {
    const id = config ? tronChainIdForVenue(config.chains) : null;
    return id === null ? null : tronChainIdHex(id);
  }, [config]);

  const adapterRef = useRef<MetaMaskAdapter | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [icon, setIcon] = useState<string | undefined>(undefined);

  // Load the library only once the venue has a Tron chain to offer.
  useEffect(() => {
    if (chainIdHex === null || adapterRef.current) return;
    let cancelled = false;
    (async () => {
      const { Buffer } = await import("buffer");
      const g = globalThis as { Buffer?: unknown };
      if (!g.Buffer) g.Buffer = Buffer;
      const { MetaMaskAdapter } =
        await import("@tronweb3/tronwallet-adapter-metamask-tron");
      if (cancelled) return;
      const adapter = new MetaMaskAdapter({
        openUrlWhenWalletNotFound: false,
        openAppWithDeeplink: false,
      });
      adapterRef.current = adapter;
      const sync = () => {
        setInstalled(String(adapter.readyState) === "Found");
        setAddress(adapter.connected ? adapter.address : null);
      };
      adapter.on("readyStateChanged", sync);
      adapter.on("connect", sync);
      adapter.on("accountsChanged", sync);
      adapter.on("disconnect", sync);
      setIcon(adapter.icon);
      sync();
      setLoaded(true);
    })().catch((err) => {
      console.error("[TronProvider] MetaMask Tron adapter failed to load", err);
    });
    return () => {
      cancelled = true;
    };
  }, [chainIdHex]);

  // The wallet adapter reads the library adapter and the venue's chain.
  useEffect(() => {
    const adapter = adapterRef.current;
    setTronWallet(adapter ? bridge(adapter) : null, chainIdHex, icon);
  }, [loaded, chainIdHex, icon]);

  const connect = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter || chainIdHex === null) {
      toast.error("This venue lists no Tron chain");
      return;
    }
    try {
      await adapter.connect();
      // MetaMask approved no Tron account: nothing to switch.
      if (!adapter.address) return;
      if ((await adapter.network()).chainId !== chainIdHex) {
        await adapter.switchChain(chainIdHex);
      }
    } catch (err) {
      const message = errorText(err);
      if (!/rejected|denied|cancel/i.test(message)) {
        toast.error(`MetaMask (Tron) connect failed: ${message}`);
      }
    }
  }, [chainIdHex]);

  const disconnect = useCallback(async () => {
    await adapterRef.current?.disconnect();
  }, []);

  const value = useMemo<TronWalletState>(
    () => ({
      available: chainIdHex !== null && loaded,
      installed,
      icon,
      address,
      connect,
      disconnect,
    }),
    [chainIdHex, loaded, installed, icon, address, connect, disconnect],
  );

  return (
    <TronWalletContext.Provider value={value}>
      {children}
    </TronWalletContext.Provider>
  );
}

export function useTronWallet(): TronWalletState {
  return useContext(TronWalletContext);
}
