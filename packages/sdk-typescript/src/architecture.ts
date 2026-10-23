/**
 * The chain architectures the venue runs on, as a closed set.
 *
 * `Chain.architecture` arrives from `GetConfig` as free text ("EVM",
 * "Solana", "Tron"). Every place the SDK behaves differently per chain
 * switches on {@link Architecture} exhaustively, so an architecture this
 * SDK does not know is an error at the point it is read, never a chain that
 * quietly takes the EVM path: on a Tron chain that path would sign with the
 * Ethereum message prefix, which the venue refuses there.
 *
 * Tron is an EVM chain for most purposes: its account is the same 20 bytes,
 * carried inside the venue as lowercase `0x` hex, its contracts are MidribV3
 * and its reads go through the node's `/jsonrpc`. It differs in how a user
 * signs (the TRON message prefix, see `./tron.ts`) and in how a transaction
 * is built and sent.
 */

/** A chain architecture the venue runs on. */
export type Architecture = "evm" | "solana" | "tron";

/**
 * Read a `Chain.architecture` string, ignoring case.
 *
 * An empty string means `evm` (the field's proto3 default, which every
 * chain configured before the field carried a value has). Anything else
 * that is not one of the three throws.
 */
export function parseArchitecture(architecture: string): Architecture {
  switch (architecture.toLowerCase()) {
    case "":
    case "evm":
      return "evm";
    case "solana":
      return "solana";
    case "tron":
      return "tron";
    default:
      throw new Error(
        `unknown chain architecture "${architecture}": expected EVM, Solana or Tron`,
      );
  }
}

/**
 * Whether accounts on `architecture` are `0x`-prefixed 20-byte hex inside
 * the venue: EVM and Tron (whose base58 `T…` form is display-only).
 */
export function isEvmAddressed(architecture: Architecture): boolean {
  switch (architecture) {
    case "evm":
    case "tron":
      return true;
    case "solana":
      return false;
    default:
      return unreachableArchitecture(architecture);
  }
}

/**
 * The `default` arm of an exhaustive switch over {@link Architecture}: a
 * compile error when a case is missing, and a throw if a value outside the
 * type reaches it at runtime anyway.
 */
export function unreachableArchitecture(architecture: never): never {
  throw new Error(`unhandled chain architecture "${String(architecture)}"`);
}
