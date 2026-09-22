// packages/telemetry/src/point-contract.ts — §13.3.1's Point carries no
// subject identifiers (M6.26). These reads must stay type errors: if any ever
// compiles, a viewer field leaked onto the Analytics Engine contract and
// `tsc --build` fails. A point is anonymous by construction, not by discipline.
import type { Point } from "./ae.js";

declare const p: Point;

// @ts-expect-error — no subject reaches Analytics Engine
void p.viewerUserId;
// @ts-expect-error — no subject reaches Analytics Engine
void p.anonId;
// @ts-expect-error — no subject reaches Analytics Engine
void p.viewSessionId;
// @ts-expect-error — no subject reaches Analytics Engine
void p.ipHash;
