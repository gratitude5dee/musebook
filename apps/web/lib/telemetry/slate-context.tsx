// apps/web/lib/telemetry/slate-context.tsx — §13.4.2. Carries slate_id +
// position down to every card; useReadTracker takes them as required props so
// no code path can construct a telemetry event without them (spine invariant 3).
"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { SlateCoords } from "./read-tracker";

const Ctx = createContext<SlateCoords | null>(null);

export function SlateProvider({
  slateId,
  position,
  children,
}: SlateCoords & { children: ReactNode }) {
  return <Ctx.Provider value={{ slateId, position }}>{children}</Ctx.Provider>;
}

export function useSlateCoords(): SlateCoords {
  const v = useContext(Ctx);
  if (v === null) {
    throw new Error("useSlateCoords outside a SlateProvider — no slate coordinates");
  }
  return v;
}
