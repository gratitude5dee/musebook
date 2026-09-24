// M16 gate control — node:crypto is allowed on workerd; this file must stay clean.
import { createHash } from "node:crypto";
export const digest = createHash("sha256").update("x").digest("hex");
