// apps/web/components/legal/LegalReviewRequired.tsx — §15.9's release brake.
// Non-production: renders the DRAFT banner above the document. Production
// builds are blocked earlier — scripts/check-legal-review.mjs fails `next
// build` when VERCEL_ENV=production and any MDX still carries the marker —
// so a shipped bundle can never display this banner.
export function LegalReviewRequired() {
  return (
    <div className="mb-6 rounded-md border-2 border-amber-500 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <strong>DRAFT — NOT LEGALLY REVIEWED.</strong> This document states the system's actual
      mechanics and is provided for review only. It must be reviewed by counsel before launch
      (§15.27 item 1).
    </div>
  );
}

export const DRAFT_MARKER = "DRAFT — NOT LEGALLY REVIEWED";
