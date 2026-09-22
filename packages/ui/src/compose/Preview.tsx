// packages/ui/src/compose/Preview.tsx — the composer's live preview pane.
// Renders the HTML the caller produces from @musebook/content's own renderer —
// the exact function the Worker uses (§14.4.3); a preview drawn by a different
// renderer is a lie with a deadline.
"use client";

export interface PreviewProps {
  /** Output of markdownToHtml(canonicalMarkdown(markdown)) — computed by the
   *  host so this package keeps its schema-only dependency. */
  html: string;
}

export function Preview({ html }: PreviewProps) {
  return (
    <article
      aria-label="Preview"
      className="mb-preview max-w-[68ch] text-[1.125rem] leading-[1.7]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
