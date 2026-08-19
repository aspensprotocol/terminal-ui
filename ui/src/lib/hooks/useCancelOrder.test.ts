/**
 * NOT_FOUND handling for order cancellation.
 *
 * The arborter now answers NOT_FOUND for a cancel of ANY order no longer
 * live in its book (replayed cancels, or ones racing a fill that just
 * completed) — not just hidden ones. `submitCancelOrder` is the plain,
 * dependency-injected core extracted from `useCancelOrder` so this is
 * testable without rendering the hook: this repo has no hook-testing
 * convention (no `renderHook` usage anywhere in `ui/src`).
 */

import { describe, expect, test, mock } from "bun:test";
import { submitCancelOrder, type CancelSubmissionDeps } from "./useCancelOrder";
import type { Order } from "@/lib/types/exchange";

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
    displayPrice: "100",
    displaySize: "10",
    displayFilledSize: "0",
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
    createSigningAdapter: () => ({
      signMessage: async () => "0x00",
    }),
    signCancel: async () => new Uint8Array([1, 2, 3]),
    submitCancel: async () => ({ order_id: "order-1" }),
    recordCancelledOrder,
    removeHiddenOrder,
    ...overrides,
  };
}

describe("submitCancelOrder NOT_FOUND handling", () => {
  test("treats NOT_FOUND on a visible order as already-gone, not an error", async () => {
    const order = makeOrder({ hidden: false });
    const deps = makeDeps({
      submitCancel: async () => {
        throw new Error("order not found");
      },
    });

    await expect(
      submitCancelOrder(order, "0xtoken", "0xuser", "order-1", deps),
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
      submitCancelOrder(order, "0xtoken", "0xuser", "order-1", deps),
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
      submitCancelOrder(order, "0xtoken", "0xuser", "order-1", deps),
    ).resolves.toBeUndefined();

    expect(deps.recordCancelledOrder).toHaveBeenCalledTimes(1);
    expect(deps.removeHiddenOrder).toHaveBeenCalledWith("order-1");
  });
});
