// packages/ui/src/thirdweb/wallets.ts — §5.2 verbatim.
import { inAppWallet, createWallet } from "thirdweb/wallets";
import { base } from "thirdweb/chains";
import type { Wallet, WalletId } from "thirdweb/wallets";

export const wallets = [
  inAppWallet({
    auth: {
      options: [
        "google",
        "apple",
        "email",
        "passkey",
        "x",
        "farcaster",
        "github",
        "telegram",
        "discord",
        "coinbase",
      ],
      mode: "popup",
    },
    // sponsorGas is NOT a top-level option (spine §4). It lives under smartAccount.
    smartAccount: { chain: base, sponsorGas: true },
    metadata: { name: "Musebook", icon: "https://cdn.musebook.dev/brand/icon.png" },
  }),
  createWallet("io.metamask"),
  createWallet("com.coinbase.wallet"),
  createWallet("me.rainbow"),
  createWallet("walletConnect"),
] as Wallet<WalletId>[];
