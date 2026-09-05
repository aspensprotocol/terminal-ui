/**
 * Subscribe to every composite member's book and return the merged view.
 *
 * One `client.onOrderbook` subscription per member, including the market
 * the single-market book is already polling — the SDK keys each
 * subscription uniquely, so the two do not collide. Mount this only while
 * the Composite tab is showing (Radix unmounts inactive tab content), or
 * every member polls for the life of the page.
 *
 * The subscription effect keys on the member ID LIST, not on the `members`
 * array's identity: the caller's array is a new object whenever the
 * selection moves between members (its market object changes), even though
 * the SET of member ids does not. Keying the effect on `members` itself
 * would tear down and rebuild every poller — and clear the merged book via
 * `clearCompositeBooks` — on every cross-member click, contradicting the
 * store's guarantee that such a click keeps the merged view intact. Passing
 * a memoized `members` array is still good practice for the merge memo
 * below (it needs the market objects), but is no longer required for
 * subscription stability.
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

  // The effect only needs each member's id. Derive a stable string key so
  // the memoized id array below (and therefore the effect) only changes
  // identity when the SET of ids actually changes, not when `members`'
  // market objects are replaced (e.g. a click that moves the selection
  // between existing members).
  const memberKey = members.map((m) => m.id).join(" ");
  const memberIds = useMemo(
    () => (memberKey === "" ? [] : memberKey.split(" ")),
    [memberKey],
  );

  useEffect(() => {
    if (memberIds.length === 0) return;
    const unsubscribes = memberIds.map((id) =>
      client.onOrderbook(id, ({ bids, asks }) =>
        setCompositeBook(id, bids, asks),
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      clearCompositeBooks();
    };
  }, [memberIds, client, setCompositeBook, clearCompositeBooks]);

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
