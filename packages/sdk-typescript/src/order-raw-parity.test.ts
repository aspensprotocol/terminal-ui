/**
 * The signed bytes and the transmitted bytes must carry the SAME raw amounts.
 *
 * The arborter verifies the envelope signature against its own re-encoding of
 * the `Order` it receives. Nothing checks that the raw price/size in those
 * bytes are the ones the wallet signed — if they differ by a single unit the
 * arborter simply recovers a different address and refuses the order for a bad
 * signature, saying nothing about an amount having moved. So the property
 * pinned here is byte parity between the two messages, not the correctness of
 * any one conversion: a test that only checked "this conversion is right"
 * would pass just as happily with the amounts re-derived a second time.
 *
 * The fixtures are chosen so float and string arithmetic genuinely DISAGREE —
 * `floatRaw` below is the derivation this change removed, and the first test
 * asserts it still disagrees. A fixture where both routes give the same answer
 * would prove nothing at all.
 */

import { describe, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { ExchangeClient, type PlaceOrderParams } from "./client.js";
import { decimalToRaw } from "./decimals.js";
import { arborterService } from "./grpc-transport.js";
import {
  OrderSchema,
  type Order,
  type SendOrderResponse,
} from "./protos/arborter_pb.js";
import { createOrderMessage, type OrderSigningData } from "./signing.js";

/** The 18-decimal market this exchange actually runs (`pair_decimals: 18`). */
const PAIR_DECIMALS = 18;
const PRICE = "1.1";
const SIZE = "1.15";

/**
 * The float derivation that used to compute the SIGNED bytes, kept here as the
 * thing the tests measure against. `10 ** 18` is not exactly representable as a
 * double, so this lands on a neighbouring multiple of the local float spacing.
 */
function floatRaw(decimal: string, decimals: number): string {
  return BigInt(
    Math.round(parseFloat(decimal) * Math.pow(10, decimals)),
  ).toString();
}

const SIGNATURE = new Uint8Array(65).fill(7);

/**
 * Swap in a capturing `sendOrder` for one call. `arborterService` is a plain
 * object literal shared by every importer, so replacing the property
 * intercepts exactly what `ExchangeClient` would have put on the wire.
 */
async function captureWireOrder(params: PlaceOrderParams): Promise<Order> {
  const original = arborterService.sendOrder;
  let captured: Order | undefined;
  arborterService.sendOrder = async (order: Order) => {
    captured = order;
    return { orderId: 42n, orderInBook: true } as SendOrderResponse;
  };
  try {
    await new ExchangeClient({ grpcUrl: "http://localhost:0" }).placeOrder(
      params,
    );
  } finally {
    arborterService.sendOrder = original;
  }
  if (!captured) throw new Error("sendOrder was never called");
  return captured;
}

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function signingData(over: Partial<OrderSigningData> = {}): OrderSigningData {
  return {
    side: "buy",
    quantity: decimalToRaw(SIZE, PAIR_DECIMALS),
    price: decimalToRaw(PRICE, PAIR_DECIMALS),
    marketId: "flare-coston2::0xaa::flare-coston2-quote::0xbb",
    baseAccountAddress: ADDRESS,
    quoteAccountAddress: ADDRESS,
    postOnly: false,
    hidden: false,
    nonce: 1_723_000_000_000n,
    ...over,
  };
}

function placeParams(over: Partial<PlaceOrderParams> = {}): PlaceOrderParams {
  return {
    userAddress: ADDRESS,
    marketId: "flare-coston2::0xaa::flare-coston2-quote::0xbb",
    side: "buy",
    orderType: "limit",
    sizeRaw: decimalToRaw(SIZE, PAIR_DECIMALS),
    priceRaw: decimalToRaw(PRICE, PAIR_DECIMALS),
    pairDecimals: PAIR_DECIMALS,
    signature: SIGNATURE,
    baseAccountAddress: ADDRESS,
    quoteAccountAddress: ADDRESS,
    postOnly: false,
    hidden: false,
    nonce: 1_723_000_000_000n,
    ...over,
  };
}

describe("the fixtures actually distinguish the two arithmetics", () => {
  test("1.1 at 18 decimals: float overshoots by 128 units", () => {
    expect(decimalToRaw(PRICE, PAIR_DECIMALS)).toBe("1100000000000000000");
    expect(floatRaw(PRICE, PAIR_DECIMALS)).toBe("1100000000000000128");
  });

  test("1.15 at 18 decimals: float undershoots by 128 units", () => {
    expect(decimalToRaw(SIZE, PAIR_DECIMALS)).toBe("1150000000000000000");
    expect(floatRaw(SIZE, PAIR_DECIMALS)).toBe("1149999999999999872");
  });
});

describe("signed bytes and transmitted bytes carry the same raw amounts", () => {
  test("a limit order: the wire Order is byte-identical to the signed one", async () => {
    const signed = toBinary(OrderSchema, createOrderMessage(signingData()));
    const wire = toBinary(OrderSchema, await captureWireOrder(placeParams()));
    expect(wire).toEqual(signed);
  });

  test("the transmitted amounts are the string-derived values, not the float ones", async () => {
    const order = await captureWireOrder(placeParams());
    expect(order.price).toBe("1100000000000000000");
    expect(order.quantity).toBe("1150000000000000000");
    expect(order.price).not.toBe(floatRaw(PRICE, PAIR_DECIMALS));
    expect(order.quantity).not.toBe(floatRaw(SIZE, PAIR_DECIMALS));
  });

  test("a market bid: budget and absent price survive the trip unchanged", async () => {
    // Two scales meet on a market bid — the amounts are in pair decimals, the
    // budget in the quote token's own units — and all of it is signed.
    const quoteBudget = "3630000";
    const over = {
      price: undefined,
      quoteBudget,
    } satisfies Partial<OrderSigningData>;
    const signed = toBinary(OrderSchema, createOrderMessage(signingData(over)));
    const wire = toBinary(
      OrderSchema,
      await captureWireOrder(
        placeParams({
          orderType: "market",
          priceRaw: undefined,
          quoteBudget,
        }),
      ),
    );
    expect(wire).toEqual(signed);
  });

  test("a raw amount past 2^53 reaches the wire exactly", async () => {
    // 9007199.254740993 base on an 18-decimal market: the raw integer is well
    // past what a double can hold, so any route through Number() truncates it.
    const sizeRaw = decimalToRaw("9007199.254740993", PAIR_DECIMALS);
    expect(sizeRaw).toBe("9007199254740993000000000");
    const signed = toBinary(
      OrderSchema,
      createOrderMessage(signingData({ quantity: sizeRaw })),
    );
    const wire = toBinary(
      OrderSchema,
      await captureWireOrder(placeParams({ sizeRaw })),
    );
    expect(wire).toEqual(signed);
  });

  test("a market order carrying a price is refused, not silently signed away", async () => {
    await expect(
      new ExchangeClient({ grpcUrl: "http://localhost:0" }).placeOrder(
        placeParams({ orderType: "market" }),
      ),
    ).rejects.toThrow(/must not carry priceRaw/);
  });
});

describe("decimalToRaw", () => {
  test("is exact where the float route drifts", () => {
    for (const [decimal, expected] of [
      ["1.1", "1100000000000000000"],
      ["1.005", "1005000000000000000"],
      ["0.07", "70000000000000000"],
      ["1.15", "1150000000000000000"],
    ] as const) {
      expect(decimalToRaw(decimal, 18)).toBe(expected);
    }
  });

  test("handles the shapes a price field can hold", () => {
    expect(decimalToRaw("0", 18)).toBe("0");
    expect(decimalToRaw("5", 6)).toBe("5000000");
    expect(decimalToRaw(".5", 6)).toBe("500000");
    expect(decimalToRaw("12.", 6)).toBe("12000000");
    expect(decimalToRaw(" 1.5 ", 6)).toBe("1500000");
    expect(decimalToRaw("-1.5", 6)).toBe("-1500000");
    expect(decimalToRaw("0.000", 6)).toBe("0");
    expect(decimalToRaw("-0.0000001", 6)).toBe("0"); // no signed zero
    // `Number.prototype.toString` emits exponent form for small magnitudes,
    // and a reference price arrives here that way.
    expect(decimalToRaw("1e-7", 6)).toBe("0");
    expect(decimalToRaw("1.5e-3", 6)).toBe("1500");
    expect(decimalToRaw("1.5e3", 6)).toBe("1500000000");
  });

  test("truncates below the scale rather than rounding up", () => {
    // The scale cannot represent the extra digit; asking for less than the
    // user typed is safe in a way that asking for more is not.
    expect(decimalToRaw("1.9999999", 6)).toBe("1999999");
    expect(decimalToRaw("-1.9999999", 6)).toBe("-1999999");
  });

  test("rejects what is not a number instead of yielding a silent zero", () => {
    for (const bad of ["", ".", "abc", "1.2.3", "1,5", "0x10", "1e2000"]) {
      expect(() => decimalToRaw(bad, 18)).toThrow();
    }
  });
});
