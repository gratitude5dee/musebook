// apps/edge/src/auth/require-agent.ts — M3's scope-enforcement surface.
// The implementation lives in packages/connectors so musebook-edge and
// musebook-mcp share one copy (§5.7.5); this module is the edge's import site.
export {
  requireAgentScope,
  type AgentGate,
  type OwnerAgent,
  type SpendPurpose,
  type SpendRequest,
} from "@musebook/connectors";
