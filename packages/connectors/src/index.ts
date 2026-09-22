// @musebook/connectors — §5.7.5's scope/budget gate and §5.7.7's audit writer.
export {
  requireAgentScope,
  QUARANTINE_ALLOWED,
  type AgentGate,
  type OwnerAgent,
  type SpendPurpose,
  type SpendRequest,
} from "./require-agent-scope.js";
export { audit, auditFromActor, type AuditRecord } from "./audit.js";
