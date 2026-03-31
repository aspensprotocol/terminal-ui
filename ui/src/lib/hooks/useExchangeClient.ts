/**
 * Hook for accessing the ExchangeClient singleton
 */

import { useMemo } from "react";
import { getExchangeClient } from "../api";

/**
 * Returns the singleton ExchangeClient instance.
 * Memoized to prevent unnecessary re-instantiation on re-renders.
 */
export function useExchangeClient() {
  return useMemo(() => getExchangeClient(), []);
}
