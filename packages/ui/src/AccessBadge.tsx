// packages/ui/src/AccessBadge.tsx — §14.2.9. Always icon + text, never
// icon-only. The VALUE is the kernel's toAccessBadge() output, computed in
// musebook-edge (§6.12.2) and read out of the JSON twin; it arrives as a prop.
import type { AccessBadgeView } from "@musebook/schema";

export interface AccessBadgeProps {
  view: AccessBadgeView;
  size?: "sm" | "md"; // sm = h-5/11px, md = h-6/12px
  interactive?: boolean; // md only: renders as a button for a popover anchor
  onScrim?: boolean; // reels/media overlay variant: forced light foreground
}

function UnlockIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  );
}
function TurnstileIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden
    >
      <path d="M7 17 17 7M9 7h8v8" />
      <path d="M3 12h3M18 12h3" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function AccessBadge({
  view,
  size = "md",
  interactive = false,
  onScrim = false,
}: AccessBadgeProps) {
  const label =
    view.kind === "open"
      ? "Open"
      : view.kind === "toll"
        ? `Toll · $${view.priceUsd ?? "0.00"}`
        : `Gated · $${view.priceUsd ?? "0.00"}`;
  const icon =
    view.kind === "open" ? <UnlockIcon /> : view.kind === "toll" ? <TurnstileIcon /> : <LockIcon />;
  const cls = [
    "inline-flex items-center gap-1 rounded-sm font-medium leading-none",
    size === "sm" ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-xs",
    view.kind === "open"
      ? "bg-muted text-muted-foreground"
      : "bg-gate-tint text-gate" + (view.kind === "gated" ? " border border-gate/30" : ""),
    onScrim ? "text-white" : "",
    interactive ? "cursor-pointer hover:bg-accent" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const ariaLabel = `${label}. ${view.rule}`;
  if (interactive) {
    return (
      <button type="button" className={cls} aria-label={ariaLabel}>
        {icon}
        <span>{label}</span>
      </button>
    );
  }
  return (
    <span className={cls} aria-label={ariaLabel}>
      {icon}
      <span>{label}</span>
    </span>
  );
}
