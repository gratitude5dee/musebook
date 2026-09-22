// packages/ui/src/UnlockGate.tsx — the x402 paywall state machine (rendered, not driven).
// §14.4.2: renders IN PLACE under the free preview, never a Dialog; the two entry
// points (the kernel teaser's unlock.js island and /pay/{postId}) mount the same
// component with the same copy, word for word.
import type { DenyReason } from "@musebook/schema";

export type UnlockState =
  | { status: "locked"; priceUsd: string; asset: "USDC"; network: "Base" }
  | { status: "quoting" }
  | { status: "signing" }
  | { status: "settling"; txHash?: string }
  | { status: "unlocked"; grantId: string }
  | {
      status: "error";
      /** §6.2's DenyReason, verbatim, plus the two codes only a wallet can produce. */
      code: DenyReason | "insufficient_funds" | "wallet_declined";
      message: string;
      newPriceUsd?: string;
    };

export interface UnlockGateProps {
  state: UnlockState;
  authorHandle: string;
  onUnlock: () => void;
  onRetry: () => void;
  onCancel: () => void;
}

export function UnlockGate({ state, authorHandle, onUnlock, onRetry, onCancel }: UnlockGateProps) {
  return (
    <div className="rounded-md border border-border-strong bg-card p-6">
      <div aria-live="assertive">
        {state.status === "locked" && (
          <div className="flex flex-col gap-2">
            <p className="display-m">This one is paid.</p>
            <p className="body-s text-muted-foreground">
              Unlock the rest for ${state.priceUsd}. @{authorHandle} gets the creator share.
            </p>
            <button
              type="button"
              onClick={onUnlock}
              className="bg-primary text-primary-foreground rounded-md px-4 py-2"
            >
              Unlock · ${state.priceUsd}
            </button>
            <a href="/publishing-modes#x402" className="body-s text-muted-foreground underline">
              How x402 works
            </a>
          </div>
        )}
        {state.status === "quoting" && (
          <button type="button" disabled aria-busy="true" className="rounded-md px-4 py-2">
            Requesting…
          </button>
        )}
        {state.status === "signing" && (
          <div className="flex items-center gap-4">
            <p>Sign in your wallet</p>
            <button type="button" onClick={onCancel} className="underline">
              Cancel
            </button>
          </div>
        )}
        {state.status === "settling" && (
          <p>
            Settling on Base…{" "}
            {state.txHash !== undefined && <code className="mono-s">{state.txHash}</code>}
          </p>
        )}
        {state.status === "unlocked" && <p>Unlocked.</p>}
        {state.status === "error" && (
          <div className="text-destructive flex items-center gap-4">
            <p>
              {state.message}
              {state.newPriceUsd !== undefined && ` It's now $${state.newPriceUsd}.`}
            </p>
            <button type="button" onClick={onRetry} className="underline">
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
