/**
 * FCE read adapters — turning `/direct` snapshot payloads into the same
 * enhanced shapes the gRPC path produces.
 *
 * The point of pinning these is that FCE reads carry a DIFFERENT payload from
 * the gRPC stream (pre-aggregated book levels, and a flat trade record), so a
 * silent mismatch here shows up as a mis-coloured tape or a mis-attributed fill
 * rather than as an error.
 */

import { describe, expect, test } from "bun:test";
import {
  fceBookToEnhanced,
  fceOpenOrdersToEnhanced,
  fceTradesToEnhanced,
} from "./reads.js";

const DECIMALS = 6;

describe("fceBookToEnhanced", () => {
  test("maps pre-aggregated levels and keeps side ordering", () => {
    const { bids, asks } = fceBookToEnhanced(
      {
        marketId: "m",
        bids: [{ price: "900000", quantity: "1000000" }],
        asks: [{ price: "1100000", quantity: "2000000" }],
      },
      DECIMALS,
    );
    expect(bids.length).toBe(1);
    expect(asks.length).toBe(1);
    expect(bids[0]?.priceValue).toBeCloseTo(0.9);
    expect(asks[0]?.sizeValue).toBeCloseTo(2);
  });

  /** A zero-quantity level is a consumed price point, not depth. */
  test("drops zero-quantity levels", () => {
    const { bids } = fceBookToEnhanced(
      {
        marketId: "m",
        bids: [
          { price: "900000", quantity: "0" },
          { price: "850000", quantity: "1000000" },
        ],
        asks: [],
      },
      DECIMALS,
    );
    expect(bids.length).toBe(1);
    expect(bids[0]?.priceValue).toBeCloseTo(0.85);
  });
});

describe("fceOpenOrdersToEnhanced", () => {
  test("maps side and attributes the order to the querying trader", () => {
    const orders = fceOpenOrdersToEnhanced(
      {
        openOrders: [
          {
            orderId: 7,
            marketId: "m",
            side: "BID",
            price: "900000",
            quantity: "1000000",
            state: "CONFIRMED",
          },
        ],
      },
      "m",
      "0xme",
      DECIMALS,
    );
    expect(orders.length).toBe(1);
    expect(orders[0]?.side).toBe("buy");
    // GET_MY_STATE is already scoped to the trader, so the address is known.
    expect(orders[0]?.user_address).toBe("0xme");
    expect(orders[0]?.priceValue).toBeCloseTo(0.9);
  });

  test("ASK maps to sell", () => {
    const orders = fceOpenOrdersToEnhanced(
      {
        openOrders: [
          {
            orderId: 8,
            marketId: "m",
            side: "ASK",
            price: "1",
            quantity: "1",
            state: "CONFIRMED",
          },
        ],
      },
      "m",
      "0xme",
      DECIMALS,
    );
    expect(orders[0]?.side).toBe("sell");
  });
});

describe("fceTradesToEnhanced", () => {
  const base = {
    timestamp: 1_700_000_000_000,
    price: "1000000",
    quantity: "2000000",
    orderHit: 42,
    makerBaseAddress: "0xmb",
    makerQuoteAddress: "0xmq",
    takerBaseAddress: "0xtb",
    takerQuoteAddress: "0xtq",
  };

  /**
   * Side comes from the ROLES. Taker-bought is a "buy"; taker-sold is a "sell".
   * Getting this backwards inverts the colour of every row in the tape.
   */
  test("taker-bought is a buy, and addresses follow the roles", () => {
    const [t] = fceTradesToEnhanced(
      { trades: [{ ...base, buyerIs: "TAKER", sellerIs: "MAKER" }] },
      "m",
      DECIMALS,
    );
    expect(t?.side).toBe("buy");
    expect(t?.buyer_address).toBe("0xtb");
    expect(t?.seller_address).toBe("0xmb");
  });

  test("taker-sold is a sell, with the addresses swapped", () => {
    const [t] = fceTradesToEnhanced(
      { trades: [{ ...base, buyerIs: "MAKER", sellerIs: "TAKER" }] },
      "m",
      DECIMALS,
    );
    expect(t?.side).toBe("sell");
    expect(t?.buyer_address).toBe("0xmb");
    expect(t?.seller_address).toBe("0xtb");
  });

  /**
   * A redacted hidden side arrives as an empty address. It must STAY empty —
   * borrowing the visible side's address would flip the "is this my fill?"
   * comparison consumers make, i.e. attribute someone else's trade to the user.
   */
  test("a redacted hidden side keeps its empty address", () => {
    const [t] = fceTradesToEnhanced(
      {
        trades: [
          {
            ...base,
            makerBaseAddress: "",
            makerQuoteAddress: "",
            buyerIs: "TAKER",
            sellerIs: "MAKER",
          },
        ],
      },
      "m",
      DECIMALS,
    );
    expect(t?.buyer_address).toBe("0xtb");
    expect(t?.seller_address).toBe("");
  });

  /** An unknown role must not be guessed into a side. */
  test("an unset role yields no confident side rather than a wrong one", () => {
    const [t] = fceTradesToEnhanced(
      { trades: [{ ...base, buyerIs: "", sellerIs: "" }] },
      "m",
      DECIMALS,
    );
    expect(t?.buyer_address).toBe("");
    expect(t?.seller_address).toBe("");
  });
});
