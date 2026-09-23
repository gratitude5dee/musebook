// packages/ui/src/distribution/VariantCard.tsx  (§12.3.7 verbatim shape)
"use client";
import { useMemo, type ReactElement } from "react";
import type { PlatformConstraint } from "@musebook/distributor/constraints";
import { countEffective } from "@musebook/distributor/count";
import { validateVariant, type VariantCandidate } from "@musebook/distributor/validate";

export function VariantCard(props: {
  candidate: VariantCandidate;
  constraint: PlatformConstraint;
  /** Set when the post is not `free` — the card then carries the mandated
   *  line that the syndicated copy will be public on this platform. */
  gated?: boolean;
  onEdit?: ((body: string) => void) | undefined;
  onRegenerate?: (() => void) | undefined;
  onExclude?: (() => void) | undefined;
}): ReactElement {
  const { candidate, constraint } = props;
  const report = useMemo(() => validateVariant(candidate, constraint), [candidate, constraint]);
  const used = countEffective(constraint.countMethod, candidate.body, constraint.urlCountsAsChars);
  const unit =
    constraint.countMethod === "utf8_bytes"
      ? "UTF-8 bytes"
      : constraint.countMethod === "graphemes"
        ? "graphemes"
        : constraint.countMethod === "x_weighted"
          ? "weighted units"
          : "characters";

  return (
    <section aria-labelledby={`v-${constraint.slug}`} className="variant-card">
      <h3 id={`v-${constraint.slug}`}>{constraint.displayName}</h3>
      {props.gated === true ? (
        <p className="variant-card-banner" role="note">
          This post is gated on musebook.dev. The copy below will be public and free to read on this
          platform.
        </p>
      ) : null}
      <p aria-live="polite">
        {used} / {constraint.maxChars} {unit}
      </p>
      <textarea value={candidate.body} onChange={(e) => props.onEdit?.(e.currentTarget.value)} />
      <ul>
        {report.checks
          .filter((c) => !c.ok)
          .map((c) => (
            <li key={c.id} data-severity={c.severity}>
              {c.severity === "warning" ? "UNVERIFIED — " : ""}
              {c.detail}
            </li>
          ))}
      </ul>
      <div className="variant-card-actions">
        {props.onRegenerate !== undefined ? (
          <button type="button" onClick={props.onRegenerate}>
            Regenerate
          </button>
        ) : null}
        {props.onExclude !== undefined ? (
          <button type="button" onClick={props.onExclude}>
            Exclude
          </button>
        ) : null}
      </div>
    </section>
  );
}
