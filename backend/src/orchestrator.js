import { randomUUID } from "node:crypto";
import { AGENTS, runAgent } from "./agents.js";
import { discoverMockSystem } from "./adapters.js";

const HANDOFFS = {
  abap: ["architect"],
  "cds-rap": ["architect", "abap"],
  fiori: ["architect", "cds-rap"],
  integration: ["architect"],
  debug: ["architect", "abap", "integration"],
  testing: ["architect", "abap", "cds-rap", "fiori", "integration"],
  review: ["abap", "cds-rap", "fiori", "integration"],
  security: ["abap", "cds-rap", "fiori", "integration"],
  compatibility: ["architect", "abap", "cds-rap", "fiori", "integration"],
  documentation: ["architect", "abap", "testing", "review", "security"],
  devops: ["architect", "testing", "review", "security", "documentation"]
};

export async function executeWorkflow({ prompt, systemId, model, onAgent }) {
  if (!prompt?.trim()) throw new Error("A development prompt is required.");
  const aiProvider = model ? "openai" : "mock";
  const system = await discoverMockSystem(systemId || "mock-ecc");
  const context = { system, note: "Mock environment only; no live SAP repository was accessed." };
  const sequence = ["architect","abap","cds-rap","fiori","integration","debug","testing","review","security","compatibility","documentation","devops"];
  const outputs = {};
  const activities = [];
  const mockStepDelayMs = Math.max(0, Number(process.env.MOCK_AGENT_STEP_DELAY_MS ?? 200));
  for (const agentId of sequence) {
    const started = Date.now();
    const event = { agentId, name: AGENTS.find(a => a.id === agentId).name, status: "RUNNING", durationMs: 0 };
    activities.push(event);
    if (onAgent) await onAgent(event);
    if (!model && mockStepDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, mockStepDelayMs));
    }
    const priorAgentWork = Object.fromEntries((HANDOFFS[agentId] || [])
      .filter(priorId => outputs[priorId])
      .map(priorId => [priorId, outputs[priorId].slice(0, 1600)]));
    const output = await runAgent(agentId, {
      prompt,
      system,
      context: { ...context, priorAgentWork }
    }, model);
    outputs[agentId] = output;
    event.status = "COMPLETED";
    event.durationMs = Date.now() - started;
    if (onAgent) await onAgent(event);
  }
  const artifactId = randomUUID();
  const artifact = {
    id: artifactId,
    title: "Generated SAP development draft",
    type: "text/markdown",
    content: `# JDAP Development Draft\n\n## Execution context\n- AI provider: ${aiProvider.toUpperCase()}\n- SAP target: ${system.name} (${system.release}) — MOCK ONLY\n- SAP connectivity: none; no SAP repository was accessed\n\n## Requirement\n${prompt}\n\n## Architecture\n${outputs.architect}\n\n## ABAP draft\n\`\`\`abap\n${outputs.abap}\n\`\`\`\n\n## CDS / RAP\n${outputs["cds-rap"]}\n\n## Fiori\n${outputs.fiori}\n\n## Integration\n${outputs.integration}\n\n## Debugging considerations\n${outputs.debug}\n\n## Testing\n${outputs.testing}\n\n## Code review\n${outputs.review}\n\n## Security\n${outputs.security}\n\n## Compatibility\n${outputs.compatibility}\n\n## Documentation\n${outputs.documentation}\n\n## DevOps\n${outputs.devops}\n\n---\n**Safety:** Draft only. No SAP connectivity, syntax check, activation, transport or deployment was performed.\n`
  };
  return { id: randomUUID(), status: "COMPLETED", aiProvider, sapConnectivity: "MOCK ONLY", system, activities, outputs, artifact, createdAt: new Date().toISOString() };
}
