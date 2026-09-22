import noActionEventsAtServeTime from "./rules/no-action-events-at-serve-time.js";
import noNodeNativeInWorker from "./rules/no-node-native-in-worker.js";
import noPlatformImportsInMixer from "./rules/no-platform-imports-in-mixer.js";
import noPublishModeOutsideKernel from "./rules/no-publish-mode-outside-kernel.js";
import noSameOriginArtifactSandbox from "./rules/no-same-origin-artifact-sandbox.js";

export default {
  meta: { name: "@musebook/eslint-plugin", version: "0.0.0" },
  rules: {
    // Spine invariants. Enabled from M1.
    "no-publish-mode-outside-kernel": noPublishModeOutsideKernel,
    "no-platform-imports-in-mixer": noPlatformImportsInMixer,
    // Authored by §13 (M11) and §11 (M16). Exported here because a rule that
    // index.js does not export is a file ESLint never loads.
    "no-action-events-at-serve-time": noActionEventsAtServeTime,
    "no-node-native-in-worker": noNodeNativeInWorker,
    "no-same-origin-artifact-sandbox": noSameOriginArtifactSandbox,
  },
};
