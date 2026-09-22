// packages/ui/src/compose/ModePicker.tsx — §14.4.5 verbatim contract:
// role="radiogroup" over the three AccessChoices, a decimal-string price
// input with a $ prefix and stepper, and the license group. The Toll row
// carries the honest sentence word for word — do not soften it.
"use client";

import { useEffect, useRef, useState } from "react";
import type { AccessChoice } from "./types";

export const LICENSE_OPTIONS = [
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
  "CC-BY-ND-4.0",
  "ARR",
  "MIT",
  "Apache-2.0",
] as const;

const MODES: { value: AccessChoice; name: string; rule: string; priceNote: string }[] = [
  {
    value: "open",
    name: "Open",
    rule: "Free for everyone, human and machine.",
    priceNote: "Best for reach.",
  },
  {
    value: "toll",
    name: "Toll",
    rule:
      "Free for people. Agents pay once to crawl it. An agent that doesn't declare itself " +
      "is served as a person. Toll is a declared contract, not a detection guarantee.",
    priceNote: "x402 per crawl",
  },
  {
    value: "gated",
    name: "Gated",
    rule: "Every read is paid, human or agent. The first paragraph stays free.",
    priceNote: "x402 on every request",
  },
];

interface LicensePatch {
  priceUsd: string;
  licenseSpdx: string;
  trainAi: boolean;
  aiUse: boolean;
  searchIndexable: boolean;
}

export interface ModePickerProps {
  value: AccessChoice;
  priceUsd: string;
  licenseSpdx: string;
  trainAi: boolean;
  aiUse: boolean;
  searchIndexable: boolean;
  /** True once the post is published — switching a paid mode to Open then
   *  shows the re-file line verbatim (§14.4.5). */
  published: boolean;
  onChange(next: { access: AccessChoice } & LicensePatch): void;
  onClose?: () => void;
}

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1 text-sm">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full border border-border-strong transition-colors ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-card transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </label>
  );
}

export function ModePicker({
  value,
  priceUsd,
  licenseSpdx,
  trainAi,
  aiUse,
  searchIndexable,
  published,
  // eslint-disable-next-line @typescript-eslint/unbound-method -- a plain prop callback, not a method
  onChange,
  onClose,
}: ModePickerProps) {
  const [index, setIndex] = useState(
    Math.max(
      0,
      MODES.findIndex((m) => m.value === value),
    ),
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-mode-index="${index}"]`)?.focus();
  }, [index]);

  const emit = (access: AccessChoice, p: Partial<LicensePatch> = {}) =>
    onChange({ access, priceUsd, licenseSpdx, trainAi, aiUse, searchIndexable, ...p });

  const pick = (i: number) => {
    setIndex(i);
    const m = MODES[i];
    if (m !== undefined) emit(m.value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      pick(Math.min(MODES.length - 1, index + 1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      pick(Math.max(0, index - 1));
    } else if (e.key === "Enter" || e.key === "Escape") {
      onClose?.();
    }
  };

  return (
    <div role="dialog" aria-label="Publishing mode" onKeyDown={onKeyDown} className="w-full">
      <div role="radiogroup" ref={listRef} aria-label="Publishing mode" className="space-y-2">
        {MODES.map((m, i) => (
          <div
            key={m.value}
            data-mode-index={i}
            role="radio"
            aria-checked={index === i}
            tabIndex={index === i ? 0 : -1}
            onClick={() => pick(i)}
            className={`cursor-pointer rounded-xl border p-3 outline-none ${
              index === i ? "border-primary bg-accent" : "border-border bg-card"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{m.name}</span>
              <span className="text-xs text-muted-foreground">{m.priceNote}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{m.rule}</p>
            {index === i && m.value !== "open" && (
              <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <span className="text-sm text-muted-foreground">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={`${m.name} price in USD`}
                  value={priceUsd}
                  onChange={(e) => emit(m.value, { priceUsd: e.target.value })}
                  className="w-24 rounded-md border border-border-strong bg-background px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  aria-label="Decrease price"
                  className="h-7 w-7 rounded-md border border-border-strong text-sm"
                  onClick={() => emit(m.value, { priceUsd: stepPrice(priceUsd, -0.01) })}
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label="Increase price"
                  className="h-7 w-7 rounded-md border border-border-strong text-sm"
                  onClick={() => emit(m.value, { priceUsd: stepPrice(priceUsd, 0.01) })}
                >
                  +
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {published && MODES[index]?.value === "open" && (
        <p className="mt-3 rounded-md bg-muted p-2 text-sm text-muted-foreground">
          Changing this re-files the post&apos;s media. It can take a minute to take effect
          everywhere.
        </p>
      )}

      <fieldset className="mt-4 space-y-2 border-t border-border pt-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          License
        </legend>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>SPDX license</span>
          <select
            aria-label="SPDX license"
            value={licenseSpdx}
            onChange={(e) => emit(MODES[index]?.value ?? value, { licenseSpdx: e.target.value })}
            className="rounded-md border border-border-strong bg-background px-2 py-1 text-sm"
          >
            {LICENSE_OPTIONS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <Switch
          label="Allow AI training"
          checked={trainAi}
          onChange={(v) => emit(MODES[index]?.value ?? value, { trainAi: v })}
        />
        <Switch
          label="Allow AI use"
          checked={aiUse}
          onChange={(v) => emit(MODES[index]?.value ?? value, { aiUse: v })}
        />
        <Switch
          label="Searchable"
          checked={searchIndexable}
          onChange={(v) => emit(MODES[index]?.value ?? value, { searchIndexable: v })}
        />
      </fieldset>
    </div>
  );
}

/** Decimal-string stepper: parse to integer hundredths, step, re-emit the
 *  two-place string. Never a float on the money path. */
function stepPrice(usd: string, deltaUsd: number): string {
  const m = /^(\d*)(?:\.(\d{1,2}))?/.exec(usd.trim());
  const cents =
    m === null
      ? 0
      : Number(m[1] || "0") * 100 + Number((m[2] ?? "0").padEnd(2, "0").slice(0, 2) || "0");
  const centsDelta = Math.round(deltaUsd * 100);
  return (Math.max(0, cents + centsDelta) / 100).toFixed(2);
}
