// packages/connectors/test/contract/all.test.ts — §17.10 verbatim
import { describe } from "vitest";
import { runConnectorContract } from "./suite.js";
import { mcpHttpHarness, a2aHarness, openApiHarness, bridgeHarness } from "./harnesses.js";

for (const h of [mcpHttpHarness, a2aHarness, openApiHarness, bridgeHarness]) {
  describe(`AgentConnector contract — ${h.name}`, () => runConnectorContract(h));
}
