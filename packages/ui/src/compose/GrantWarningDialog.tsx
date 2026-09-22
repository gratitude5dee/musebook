// packages/ui/src/compose/GrantWarningDialog.tsx — §1.4's edit-after-grant
// interruption (§14.4.3): an AlertDialog over a draft save whose new
// content_hash differs while grants are live. Hand-rolled — this repo ships
// no Radix/vaul primitives, and the contract that matters is the role.
"use client";

export interface GrantWarningDialogProps {
  open: boolean;
  grantCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function GrantWarningDialog({
  open,
  grantCount,
  onConfirm,
  onCancel,
}: GrantWarningDialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="grant-warning-title"
        aria-describedby="grant-warning-body"
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-e4"
      >
        <h2 id="grant-warning-title" className="text-lg font-semibold">
          This changes what readers paid for
        </h2>
        <p id="grant-warning-body" className="mt-2 text-sm text-muted-foreground">
          This edit changes the post&apos;s fingerprint. {grantCount}{" "}
          {grantCount === 1 ? "person has" : "people have"} already paid for the current version;
          they keep what they bought, and new readers pay for the new version.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            Save anyway
          </button>
        </div>
      </div>
    </div>
  );
}
