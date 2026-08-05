/**
 * Hook for accessing the ExchangeClient singleton
 */

import { useMemo } from "react";
import { getExchangeClient } from "../api";
import { useFceEnabled } from "../providers/fce-context";

/**
 * Returns the singleton ExchangeClient instance.
 * Memoized to prevent unnecessary re-instantiation on re-renders.
 */
export function useExchangeClient() {
  const fceEnabled = useFceEnabled();
  return useMemo(() => getExchangeClient(fceEnabled), [fceEnabled]);
}
