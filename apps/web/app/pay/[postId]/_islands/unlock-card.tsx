"use client";
// apps/web/app/pay/[postId]/_islands/unlock-card.tsx — the /pay/{postId} driver
// of §14.4.2's state machine: connect (if needed) -> quote -> sign -> settle.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useActiveAccount, useConnectModal } from "thirdweb/react";
import { client } from "@musebook/ui/thirdweb/client";
import { wallets } from "@musebook/ui/thirdweb/wallets";
import { UnlockGate, type UnlockState } from "@musebook/ui";
import { unlock, type PaymentSigner } from "./unlock";

function signerFor(account: {
  address: string;
  signTypedData: (data: unknown) => Promise<string>;
}): PaymentSigner {
  return {
    async signTransferWithAuthorization(input) {
      const nonce =
        "0x" +
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      const validBefore = String(Math.floor(Date.now() / 1000) + input.maxTimeoutSeconds);
      const chainId = Number(input.network.split(":")[1]);
      const authorization = {
        from: account.address,
        to: input.payTo,
        value: input.value,
        validAfter: "0",
        validBefore,
        nonce,
      };
      // Domain and value fields are ECHOED from the offer (§14.4.2).
      const signature = await account.signTypedData({
        domain: {
          name: input.domainName,
          version: input.domainVersion,
          chainId,
          verifyingContract: input.asset,
        },
        primaryType: "TransferWithAuthorization",
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        message: authorization,
      });
      return { signature, authorization };
    },
  };
}

export function UnlockCard({
  slug,
  postId,
  authorHandle,
  priceUsd,
}: {
  slug: string;
  postId: string;
  authorHandle: string;
  priceUsd: string;
}) {
  const account = useActiveAccount();
  const { connect } = useConnectModal();
  const router = useRouter();
  const locked: UnlockState = { status: "locked", priceUsd, asset: "USDC", network: "Base" };
  const [state, setState] = useState<UnlockState>(locked);

  async function run() {
    if (account === undefined) {
      await connect({ client, wallets });
      return; // the modal's own flow ends here; the reader taps again
    }
    setState({ status: "quoting" });
    try {
      setState({ status: "signing" });
      const result = await unlock(
        slug,
        signerFor({
          address: account.address,
          signTypedData: (d) =>
            account.signTypedData(d as Parameters<typeof account.signTypedData>[0]),
        }),
      );
      if (result.kind === "unlocked" || result.kind === "already_free") {
        setState({ status: "unlocked", grantId: postId });
        router.refresh(); // the Worker now serves the paid body
        router.push(`/p/${slug}`);
      } else {
        setState({
          status: "error",
          code: result.code as UnlockState extends { status: "error"; code: infer C } ? C : never,
          message: result.code,
          ...(result.newPriceUsd !== undefined ? { newPriceUsd: result.newPriceUsd } : {}),
        });
      }
    } catch {
      setState({
        status: "error",
        code: "wallet_declined",
        message: "Payment declined in your wallet.",
      });
    }
  }

  return (
    <UnlockGate
      state={state}
      authorHandle={authorHandle}
      onUnlock={() => void run()}
      onRetry={() => void run()}
      onCancel={() => setState(locked)}
    />
  );
}
