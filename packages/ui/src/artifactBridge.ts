// packages/ui/src/artifactBridge.ts — §11.14's host↔artifact bridge.
import { z } from "zod";

const artifactMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("musebook.ready") }),
  z.object({ v: z.literal(1), type: z.literal("musebook.resize"), height: z.number() }),
  z.object({
    v: z.literal(1),
    type: z.literal("musebook.action"),
    action: z.enum(["fork", "fullscreen"]),
  }),
]);

export type ArtifactMessage = z.infer<typeof artifactMessageSchema>;

export function listenToArtifact(
  frame: HTMLIFrameElement,
  onMessage: (m: ArtifactMessage) => void,
) {
  const handler = (event: MessageEvent) => {
    // A sandboxed frame without allow-same-origin has an OPAQUE origin, so
    // event.origin is the string "null". Identity comes from the source window.
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== "null") return;
    const parsed = artifactMessageSchema.safeParse(event.data);
    if (parsed.success) onMessage(parsed.data);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
