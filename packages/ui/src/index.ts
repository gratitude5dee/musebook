// @musebook/ui — §14.2.9's shared components + §14.4.4's composer surface.
export { AccessBadge, type AccessBadgeProps } from "./AccessBadge";
export { Composer, type ComposerProps } from "./compose/Composer";
export { GrantWarningDialog } from "./compose/GrantWarningDialog";
export { ModePicker, LICENSE_OPTIONS } from "./compose/ModePicker";
export { Preview } from "./compose/Preview";
export type {
  AccessChoice,
  ComposerActions,
  ComposerInitial,
  DraftInput,
  SavedDraft,
} from "./compose/types";
export { UnlockGate, type UnlockGateProps, type UnlockState } from "./UnlockGate";
export { ArtifactFrame } from "./ArtifactFrame";
export { ArtifactCanvas, type ArtifactCanvasProps } from "./ArtifactCanvas";
export { ArtifactViewer3D } from "./ArtifactViewer3D";
export { ModelCard } from "./ModelCard";
export { listenToArtifact, type ArtifactMessage } from "./artifactBridge";
export {
  acquireWebglSlot,
  attachContextLossGuard,
  MAX_LIVE_CONTEXTS,
  onWebglSlotFreed,
  releaseWebglSlot,
} from "./webglBudget";
