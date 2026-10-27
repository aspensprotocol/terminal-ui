/**
 * NOT_FOUND handling for order cancellation.
 *
 * The arborter answers NOT_FOUND for a cancel of ANY order no longer live
 * in its book (replayed cancels, or ones racing a fill that just
 * completed), hidden or not. `submitCancelOrder` is the plain,
 * dependency-injected core extracted from `useCancelOrder` so this is
 * testable without rendering the hook: this repo has no hook-testing
 * convention (no `renderHook` usage anywhere in `ui/src`).
 */

import { describe, expect, test, mock } from "bun:test";
import { signCancelOrder, type Market } from "@aspensprotocol/sdk-ts";
import {
  resolveCancelSigner,
  submitCancelOrder,
  type CancelSubmissionDeps,
} from "./useCancelOrder";
import type { Order } from "@/lib/types/exchange";
import type { ConnectedWallet } from "@/lib/wallet";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    user_address: "0xuser",
    market_id: "market-1",
    price: "100",
    size: "10",
    side: "buy",
    order_type: "limit",
    status: "pending",
    hidden: false,
    filled_size: "0",
    created_at: "2026-08-19T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
    priceValue: 100,
    sizeValue: 10,
    filledValue: 0,
    priceDisplay: "100",
    sizeDisplay: "10",
    filledDisplay: "0",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<CancelSubmissionDeps> = {},
): CancelSubmissionDeps & {
  recordCancelledOrder: ReturnType<typeof mock>;
  removeHiddenOrder: ReturnType<typeof mock>;
} {
  const recordCancelledOrder = mock(() => {});
  const removeHiddenOrder = mock(() => {});
  return {
    resolveSigner: (_order: Order) => ({
      adapter: { signMessage: async () => "0x00" },
      architecture: "evm",
    }),
    signCancel: async () => new Uint8Array([1, 2, 3]),
    submitCancel: async () => ({ order_id: "order-1" }),
    recordCancelledOrder,
    removeHiddenOrder,
    ...overrides,
  };
}

describe("submitCancelOrder signer selection", () => {
  test("resolves the signing adapter FROM THE ORDER, before signing", async () => {
    const order = makeOrder({
      side: "buy",
      base_account_address: "0xbase",
      quote_account_address: "0xquote",
    });
    const seen: Order[] = [];
    const signCancel = mock(
      async (_d: unknown, _a: unknown, _arch: string) => new Uint8Array([9]),
    );
    const adapter = { signMessage: async () => "0x00" };
    const deps = makeDeps({
      resolveSigner: (o: Order) => {
        seen.push(o);
        return { adapter, architecture: "solana" };
      },
      signCancel,
    });

    await submitCancelOrder(order, "0xactive", "order-1", deps);

    expect(seen).toEqual([order]);
    expect(signCancel).toHaveBeenCalledTimes(1);
    // Signed with the resolved wallet, under its chain's architecture.
    expect(signCancel.mock.calls[0]![1]).toBe(adapter);
    expect(signCancel.mock.calls[0]![2]).toBe("solana");
  });

  test("a signer-resolution failure propagates and nothing is submitted or recorded", async () => {
    const order = makeOrder({ side: "buy", quote_account_address: "0xquote" });
    const submitCancel = mock(async () => ({ order_id: "order-1" }));
    const deps = makeDeps({
      resolveSigner: () => {
        throw new Error("wallet 0xquote is not connected");
      },
      submitCancel,
    });

    await expect(
      submitCancelOrder(order, "0xactive", "order-1", deps),
    ).rejects.toThrow("0xquote");
    expect(submitCancel).not.toHaveBeenCalled();
    expect(deps.recordCancelledOrder).not.toHaveBeenCalled();
  });
});

describe("submitCancelOrder NOT_FOUND handling", () => {
  test("treats NOT_FOUND on a visible order as already-gone, not an error", async () => {
    const order = makeOrder({ hidden: false });
    const deps = makeDeps({
      submitCancel: async () => {
        throw new Error("order not found");
      },
    });

    await expect(
      submitCancelOrder(order, "0xuser", "order-1", deps),
    ).resolves.toBeUndefined();

    expect(deps.recordCancelledOrder).toHaveBeenCalledTimes(1);
    expect(deps.recordCancelledOrder.mock.calls[0][0]).toMatchObject({
      orderId: "order-1",
    });
    // Visible order: not part of the hidden-orders slice, so no cleanup call.
    expect(deps.removeHiddenOrder).not.toHaveBeenCalled();
  });

  test("still propagates non-NOT_FOUND errors", async () => {
    const order = makeOrder({ hidden: false });
    const deps = makeDeps({
      submitCancel: async () => {
        throw new Error("deadline exceeded");
      },
    });

    await expect(
      submitCancelOrder(order, "0xuser", "order-1", deps),
    ).rejects.toThrow("deadline exceeded");

    expect(deps.recordCancelledOrder).not.toHaveBeenCalled();
    expect(deps.removeHiddenOrder).not.toHaveBeenCalled();
  });

  test("also treats NOT_FOUND on a hidden order as already-gone, and cleans up the hidden slice", async () => {
    const order = makeOrder({ hidden: true });
    const deps = makeDeps({
      submitCancel: async () => {
        throw new Error("Not Found");
      },
    });

    await expect(
      submitCancelOrder(order, "0xuser", "order-1", deps),
    ).resolves.toBeUndefined();

    expect(deps.recordCancelledOrder).toHaveBeenCalledTimes(1);
    expect(deps.removeHiddenOrder).toHaveBeenCalledWith("order-1");
  });
});

describe("the cancel's architecture is the giving chain's, not the wallet's", () => {
  // An EVM-base / Tron-quote market. A Tron account is the same 20 bytes as
  // an EVM one, so the order's quote-leg (Tron) address is held by a
  // connected EVM wallet.
  const ACCOUNT = "0xa5411a1a5784b0828bbafcfa588c72ef3f3ce646";
  const market = {
    id: "evm-chain::0x01::tron-nile::0x02",
    baseChainArchitecture: "EVM",
    quoteChainArchitecture: "Tron",
  } as Market;
  const evmWallet: ConnectedWallet = {
    id: `evm:${ACCOUNT}`,
    name: "MetaMask",
    address: ACCOUNT,
    ecosystem: "evm",
  };
  const wallets = { [evmWallet.id]: evmWallet };

  test("a buy gives quote: tron; a sell gives base: evm", () => {
    const adapterFor = () => ({ signMessage: async () => "0x00" });
    const buy = makeOrder({ side: "buy", quote_account_address: ACCOUNT });
    const sell = makeOrder({ side: "sell", base_account_address: ACCOUNT });
    expect(
      resolveCancelSigner(buy, market, wallets, null, adapterFor).architecture,
    ).toBe("tron");
    expect(
      resolveCancelSigner(sell, market, wallets, null, adapterFor).architecture,
    ).toBe("evm");
  });

  test("a cancel of a Tron-giving order never reaches EIP-191 through an EVM wallet", async () => {
    const signMessage = mock(async () => "0x" + "11".repeat(65));
    const submitCancel = mock(async () => ({ order_id: "order-1" }));
    const order = makeOrder({ side: "buy", quote_account_address: ACCOUNT });
    const deps = makeDeps({
      resolveSigner: (o: Order) =>
        resolveCancelSigner(o, market, wallets, null, () => ({ signMessage })),
      signCancel: signCancelOrder,
      submitCancel,
    });

    await expect(
      submitCancelOrder(order, ACCOUNT, "0x" + "ab".repeat(32), deps),
    ).rejects.toThrow(/signTronMessage/);
    expect(signMessage).not.toHaveBeenCalled();
    expect(submitCancel).not.toHaveBeenCalled();
  });

  test("an unloaded market is refused, not signed as some default", () => {
    const order = makeOrder({ side: "buy", quote_account_address: ACCOUNT });
    expect(() =>
      resolveCancelSigner(order, undefined, wallets, null, () => ({
        signMessage: async () => "0x00",
      })),
    ).toThrow(/not loaded/);
  });
});
