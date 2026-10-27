/**
 * The bridge between MetaMask's Tron adapter and the SDK's
 * `SigningAdapter`.
 *
 * The fixtures are what MetaMask's Tron account actually returned: a
 * mainnet `TriggerSmartContract` built by the SDK (65-byte signature with
 * uppercase hex digits, v = 0x1b) and a Nile `signMessage` of an order's hex
 * text. Each test that relays a signature also recovers it to the owner, so
 * a bridge that picks the wrong field, mangles the hex, or hands the wallet
 * something other than the exact raw data / text fails rather than passing
 * on a value that merely has the right length.
 */

import { describe, expect, test } from "bun:test";
import { recoverAddress } from "viem";
import { tronMessageDigest } from "@aspensprotocol/sdk-ts";
import {
  TronWalletAdapter,
  setTronWallet,
  tronChainIdHex,
  tronChainIdForVenue,
  tronSigningAdapter,
  type MetaMaskTronLike,
  type TronTransactionRequest,
} from "./tron-adapter";

const OWNER_T = "TUtK4fK9WwmAvHF37AMLw5Rn7mzDAXu6qU";
const OWNER_HEX = "0xcf7d5ed79ca1fb60e040cde086c0be1b25289c7a";
const OTHER_T = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const MAINNET = "0x2b6653dc";
const NILE = "0xcd8690dc";

/** USDT.balanceOf(owner) on mainnet, built by the SDK and signed in MetaMask. */
const TX_ID =
  "272cb828a8be7935d59902e1d111d845be5af1418f76640c0dc914f6afe824c7";
const RAW_DATA_HEX =
  "0a02e31c220848d5d2ba1bc2377d40b084cff397345a8e01081f1289010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412540a1541cf7d5ed79ca1fb60e040cde086c0be1b25289c7a121541a614f803b6fd780986a42c78ec9c7f77e6ded13c222470a08231000000000000000000000000cf7d5ed79ca1fb60e040cde086c0be1b25289c7a70f6c8cbf3973490018087a70e";
const TX_SIGNATURE_AS_RETURNED =
  "0x9221279810a77ed0253b55000debe8ab71f1c00e953cbc596dba93dcc8a83ae468dfcfee401d6482f124e83086568251edbe24de9f59f28947dc7578be8ee3b81B";

/** An order's hex text, signed on Nile under the TRON message prefix. */
const ORDER_TEXT =
  "08021207313030303030301a06323530303030226e333434383134383138383a3a3078656565656565656565656565656565656565656565656565656565656565656565656565656565653a3a333434383134383138383a3a3078656361396263383238613330303562396133623930396632636335633261353437393464653035662a2a307863663764356564373963613166623630653034306364653038366330626531623235323839633761322a3078636637643565643739636131666236306530343063646530383663306265316232353238396337616080cefca996346807";
const ORDER_SIGNATURE =
  "0xd4bb6b1277f3e1bf6f0e48ba929b50f39c45945a1a4b5c5189ad615e4f2ddfe9481983c57c4971d4bf7daf6b512a01d25d42ddcb93fc6175a45ec52f6af84dfb1c";

interface FakeWallet extends MetaMaskTronLike {
  messages: unknown[];
  transactions: TronTransactionRequest[];
  switches: string[];
}

function fakeWallet(opts: {
  address?: string | null;
  chainId?: string;
  txSignature?: string[];
  messageSignature?: string;
  fail?: Error;
}): FakeWallet {
  let chainId = opts.chainId ?? MAINNET;
  const w: FakeWallet = {
    address: opts.address === undefined ? OWNER_T : opts.address,
    messages: [],
    transactions: [],
    switches: [],
    async signMessage(message: string) {
      w.messages.push(message);
      if (opts.fail) throw opts.fail;
      return opts.messageSignature ?? ORDER_SIGNATURE;
    },
    async signTransaction(tx: TronTransactionRequest) {
      w.transactions.push(tx);
      if (opts.fail) throw opts.fail;
      return {
        ...tx,
        signature: opts.txSignature ?? [TX_SIGNATURE_AS_RETURNED],
      };
    },
    async network() {
      return { chainId };
    },
    async switchChain(id: string) {
      w.switches.push(id);
      chainId = id;
    },
    async disconnect() {},
  };
  return w;
}

describe("TronWalletAdapter", () => {
  test("tron adapter address is hex", () => {
    setTronWallet(fakeWallet({}), MAINNET);
    const wallets = new TronWalletAdapter().getConnectedWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0]?.address).toBe(OWNER_HEX);
    expect(wallets[0]?.id).toBe(`tron:${OWNER_HEX}`);
    expect(wallets[0]?.ecosystem).toBe("tron");
    setTronWallet(null, null);
  });

  test("no wallet, or one with no account, lists nothing", () => {
    setTronWallet(null, null);
    expect(new TronWalletAdapter().getConnectedWallets()).toEqual([]);
    setTronWallet(fakeWallet({ address: null }), MAINNET);
    expect(new TronWalletAdapter().getConnectedWallets()).toEqual([]);
    setTronWallet(null, null);
  });
});

describe("tronSigningAdapter.signTronTransaction", () => {
  test("hands MetaMask the raw data unchanged and relays signature[0], lowercased", async () => {
    const wallet = fakeWallet({});
    const adapter = tronSigningAdapter(() => wallet, OWNER_HEX, MAINNET);
    const signature = await adapter.signTronTransaction!(TX_ID, RAW_DATA_HEX);

    expect(wallet.transactions).toHaveLength(1);
    const sent = wallet.transactions[0]!;
    expect(sent.raw_data_hex).toBe(RAW_DATA_HEX);
    expect(sent.txID).toBe(TX_ID);
    expect(sent.raw_data.contract[0]?.type).toBe("TriggerSmartContract");

    expect(signature).toBe(TX_SIGNATURE_AS_RETURNED.toLowerCase());
    const signer = await recoverAddress({
      hash: `0x${TX_ID}`,
      signature: signature as `0x${string}`,
    });
    expect(signer.toLowerCase()).toBe(OWNER_HEX);
  });

  test("switches MetaMask to the venue's Tron chain before signing", async () => {
    const wallet = fakeWallet({ chainId: MAINNET });
    const adapter = tronSigningAdapter(() => wallet, OWNER_HEX, NILE);
    await adapter.signTronTransaction!(TX_ID, RAW_DATA_HEX);
    expect(wallet.switches).toEqual([NILE]);

    const onChain = fakeWallet({ chainId: MAINNET });
    await tronSigningAdapter(() => onChain, OWNER_HEX, MAINNET)
      .signTronTransaction!(TX_ID, RAW_DATA_HEX);
    expect(onChain.switches).toEqual([]);
  });

  test("a wallet that returns no signature is an error", async () => {
    const wallet = fakeWallet({ txSignature: [] });
    const adapter = tronSigningAdapter(() => wallet, OWNER_HEX, MAINNET);
    await expect(
      adapter.signTronTransaction!(TX_ID, RAW_DATA_HEX),
    ).rejects.toThrow(/signature/);
  });

  test("Insufficient funds says the account must hold TRX for the fee", async () => {
    const wallet = fakeWallet({ fail: new Error("Insufficient funds") });
    const adapter = tronSigningAdapter(() => wallet, OWNER_HEX, MAINNET);
    await expect(
      adapter.signTronTransaction!(TX_ID, RAW_DATA_HEX),
    ).rejects.toThrow(/TRX/);
  });

  test("a refusal on Nile says MetaMask cannot sign Nile transactions", async () => {
    const refused = new Error("User rejected the request.");
    const nile = fakeWallet({ chainId: NILE, fail: refused });
    await expect(
      tronSigningAdapter(() => nile, OWNER_HEX, NILE).signTronTransaction!(
        TX_ID,
        RAW_DATA_HEX,
      ),
    ).rejects.toThrow(/Nile/);
    const main = fakeWallet({ chainId: MAINNET, fail: refused });
    let message = "";
    try {
      await tronSigningAdapter(() => main, OWNER_HEX, MAINNET)
        .signTronTransaction!(TX_ID, RAW_DATA_HEX);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/rejected/);
    expect(message).not.toMatch(/Nile/);
  });
});

describe("tronSigningAdapter.signTronMessage", () => {
  test("hands MetaMask the text itself and relays its signature", async () => {
    const wallet = fakeWallet({});
    const adapter = tronSigningAdapter(() => wallet, OWNER_HEX, NILE);
    const signature = await adapter.signTronMessage!(ORDER_TEXT);
    expect(wallet.messages).toEqual([ORDER_TEXT]);
    expect(typeof wallet.messages[0]).toBe("string");
    expect(signature).toBe(ORDER_SIGNATURE);
    const signer = await recoverAddress({
      hash: tronMessageDigest(ORDER_TEXT),
      signature: signature as `0x${string}`,
    });
    expect(signer.toLowerCase()).toBe(OWNER_HEX);
    // Message signing is not chain-bound, so it never prompts a switch.
    expect(wallet.switches).toEqual([]);
  });

  test("refuses when MetaMask holds a different Tron account", async () => {
    const wallet = fakeWallet({ address: OTHER_T });
    const adapter = tronSigningAdapter(() => wallet, OWNER_HEX, MAINNET);
    await expect(adapter.signTronMessage!(ORDER_TEXT)).rejects.toThrow(OWNER_T);
    expect(wallet.messages).toEqual([]);
    await expect(
      adapter.signTronTransaction!(TX_ID, RAW_DATA_HEX),
    ).rejects.toThrow(OWNER_T);
    expect(wallet.transactions).toEqual([]);
  });

  test("refuses when no Tron wallet is connected", async () => {
    const adapter = tronSigningAdapter(() => null, OWNER_HEX, MAINNET);
    await expect(adapter.signTronMessage!(ORDER_TEXT)).rejects.toThrow(/Tron/);
  });

  test("never signs under the Ethereum prefix", async () => {
    const wallet = fakeWallet({});
    const adapter = tronSigningAdapter(() => wallet, OWNER_HEX, MAINNET);
    await expect(adapter.signMessage("0x1234")).rejects.toThrow(/TRON/);
    expect(wallet.messages).toEqual([]);
  });
});

describe("venue chain selection", () => {
  test("chain ids map to MetaMask's hex chain ids", () => {
    expect(tronChainIdHex(728126428)).toBe(MAINNET);
    expect(tronChainIdHex(3448148188)).toBe(NILE);
  });

  test("the venue's Tron chain is the one with the Tron architecture", () => {
    const chains = [
      { architecture: "EVM", chainId: 84532 },
      { architecture: "Tron", chainId: 3448148188 },
      { architecture: "Solana", chainId: 0 },
    ];
    expect(tronChainIdForVenue(chains)).toBe(3448148188);
    expect(
      tronChainIdForVenue(chains.filter((c) => c.architecture !== "Tron")),
    ).toBeNull();
  });
});
