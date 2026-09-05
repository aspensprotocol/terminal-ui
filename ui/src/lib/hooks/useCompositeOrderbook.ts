/**
 * Subscribe to every composite member's book and return the merged view.
 *
 * One `client.onOrderbook` subscription per member, including the market
 * the single-market book is already polling — the SDK keys each
 * subscription uniquely, so the two do not collide. Mount this only while
 * the Composite tab is showing (Radix unmounts inactive tab content), or
 * every member polls for the life of the page.
 *
 * `members` is an effect dependency: pass a memoized array.
 */

import { useEffect, useMemo } from "react";
import type { Market } from "@/lib/types/exchange";
import { useExchangeStore } from "../store";
import { useExchangeClient } from "./useExchangeClient";
import {
  mergeMemberBooks,
  spreadOf,
  withCumulative,
  type CompositeLevel,
} from "../composite";

export function useCompositeOrderbook(members: Market[]) {
  const client = useExchangeClient();
  const setCompositeBook = useExchangeStore((s) => s.setCompositeBook);
  const clearCompositeBooks = useExchangeStore((s) => s.clearCompositeBooks);
  const compositeBooks = useExchangeStore((s) => s.compositeBooks);

  useEffect(() => {
    if (members.length === 0) return;
    const unsubscribes = members.map((m) =>
      client.onOrderbook(m.id, ({ bids, asks }) =>
        setCompositeBook(m.id, bids, asks),
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      clearCompositeBooks();
    };
  }, [members, client, setCompositeBook, clearCompositeBooks]);

  const { bids, asks } = useMemo(
    () =>
      mergeMemberBooks(
        members.map((m) => ({
          market: m,
          bids: compositeBooks[m.id]?.bids ?? [],
          asks: compositeBooks[m.id]?.asks ?? [],
        })),
      ),
    [members, compositeBooks],
  );

  const asksWithCumulative = useMemo(() => withCumulative(asks), [asks]);
  const bidsWithCumulative = useMemo(() => withCumulative(bids), [bids]);
  const maxAskCumulative =
    asksWithCumulative[asksWithCumulative.length - 1]?.cumulative ?? 1;
  const maxBidCumulative =
    bidsWithCumulative[bidsWithCumulative.length - 1]?.cumulative ?? 1;
  const spread = useMemo(() => spreadOf(bids, asks), [bids, asks]);

  return {
    bids,
    asks,
    asksWithCumulative,
    bidsWithCumulative,
    maxAskCumulative,
    maxBidCumulative,
    spread,
  } satisfies {
    bids: CompositeLevel[];
    asks: CompositeLevel[];
    asksWithCumulative: Array<CompositeLevel & { cumulative: number }>;
    bidsWithCumulative: Array<CompositeLevel & { cumulative: number }>;
    maxAskCumulative: number;
    maxBidCumulative: number;
    spread: { spreadValue: number; spreadPercentage: string };
  };
}
