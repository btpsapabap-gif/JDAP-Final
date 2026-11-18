import { randomUUID } from "node:crypto";
import { AGENTS } from "../agents/registry.js";
import { runAgent } from "../agents/runner.js";
import { discoverMockSystem } from "../integrations/sap-mock.js";
import { evaluateAbapDraft, normalizeAbapAgentOutput, renderDraftQualitySections } from "../integrations/abap-static/draft-quality.js";

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

const SELECTION_TEXTS = [
  ["S_FKDAT", "Billing date"],
  ["S_VBELN", "Billing document number"],
  ["S_KUNAG", "Sold-to party"],
  ["P_VKORG", "Sales organization"]
];

const AGENT_SELECTION_RULES = [
  ["abap", /\babap\b|\b(report|program|include)\b|selection screen/i],
  ["cds-rap", /\bcds\b|\brap\b|behavior definition|service definition|business object/i],
  ["fiori", /\bfiori\b|\bsapui5\b|\bui5\b|user interface|list report|object page/i],
  ["integration", /\b(idoc|rfc|bapi|odata|api|interface|integration)\b/i],
  ["debug", /\b(debug|troubleshoot|dump|error analysis|incident)\b/i]
];

const SUPPORT_AGENT_RULES = [
  ["testing", /\b(test|test plan|testing|qa|validate|validation|regression)\b/i],
  ["security", /\b(secur|authori[sz]ation|permission|credential|safe|least privilege)\b/i],
  ["review", /\b(review|refactor|code quality|performance|maintainability)\b/i],
  ["compatibility", /\b(compatib|release|ecc|s\/4|s4hana|version)\b/i],
  ["documentation", /\b(documentation|technical handover|readme|user guide)\b/i],
  ["devops", /\b(devops|deploy|deployment|docker|pipeline|ci\/cd|transport)\b/i]
];

export function selectWorkflowAgents(prompt = "") {
  const selected = new Set();
  for (const [agentId, pattern] of AGENT_SELECTION_RULES) {
    if (pattern.test(prompt)) selected.add(agentId);
  }
  for (const [agentId, pattern] of SUPPORT_AGENT_RULES) {
    if (pattern.test(prompt)) selected.add(agentId);
  }

  // Architecture is useful for broad design or multi-domain work. Focused
  // implementation requests go straight to the matching specialist.
  const primaryCount = [...selected].filter(id => AGENT_SELECTION_RULES.some(([primaryId]) => primaryId === id)).length;
  if (/\b(architect|architecture|solution design|system design|end-to-end|across|multiple applications)\b/i.test(prompt)
    || primaryCount > 1
    || selected.size === 0) {
    selected.add("architect");
  }

  return AGENTS.filter(agent => selected.has(agent.id)).map(({ id, name }) => ({ id, name }));
}

function selectionTextsFor(source = "") {
  return SELECTION_TEXTS.filter(([name]) => new RegExp(`\\b${name}\\b`, "i").test(source));
}

export async function executeWorkflow({ prompt, systemId, model, provider, sapContext, onAgent }) {
  if (!prompt?.trim()) throw new Error("A development prompt is required.");
  const aiProvider = model ? (provider || model.provider || "openai") : "mock";
  const system = await discoverMockSystem(systemId || "mock-ecc");
  const context = {
    system,
    note: sapContext ? "Live OData read-only sample supplied; the SAP development repository was not accessed." : "Mock environment only; no live SAP repository was accessed.",
    ...(sapContext ? { sapODataSample: { entitySet: sapContext.entitySet, transport: sapContext.transport, fields: sapContext.fields, firstRow: sapContext.sample } } : {})
  };
  const selectedAgents = selectWorkflowAgents(prompt);
  const sequence = selectedAgents.map(agent => agent.id);
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
    const agentContext = { ...context, priorAgentWork };
    if (sapContext && !["architect", "abap"].includes(agentId)) delete agentContext.sapODataSample;
    const output = await runAgent(agentId, {
      prompt,
      system,
      context: agentContext
    }, model);
    outputs[agentId] = agentId === "abap" ? normalizeAbapAgentOutput(output) : output;
    event.status = "COMPLETED";
    event.durationMs = Date.now() - started;
    if (onAgent) await onAgent(event);
  }
  const artifactId = randomUUID();
  const selectionTexts = selectionTextsFor(outputs.abap);
  const selectionTextsSection = selectionTexts.length
    ? `## Selection screen texts\n\n${selectionTexts.map(([name, label]) => `- ${name}: ${label}`).join("\n")}\n\n`
    : "";
  const liveContextNote = sapContext
    ? `\n## Live SAP data context\n- OData entity set: ${sapContext.entitySet}\n- Transport: ${sapContext.transport}\n- First-row fields supplied to agents: ${sapContext.fields.join(", ")}\n- SAP returned ${sapContext.rowsReceived} row(s) for a $top=1 request; JDAP retained only the first row.\n- A live data row was included in agent context; review generated content for sensitive values before sharing.\n`
    : "";
  const outputSections = [
    ["architect", "Architecture"], ["abap", "ABAP draft"], ["cds-rap", "CDS / RAP"],
    ["fiori", "Fiori"], ["integration", "Integration"], ["debug", "Debugging considerations"],
    ["testing", "Testing"], ["review", "Code review"], ["security", "Security"],
    ["compatibility", "Compatibility"], ["documentation", "Documentation"], ["devops", "DevOps"]
  ].filter(([agentId]) => outputs[agentId]).map(([agentId, title]) => {
    const body = agentId === "abap" ? `\`\`\`abap\n${outputs[agentId]}\n\`\`\`` : outputs[agentId];
    return `## ${title}\n${body}`;
  }).join("\n\n");
  const qualityGate = outputs.abap ? evaluateAbapDraft(outputs.abap, system) : null;
  const qualitySections = renderDraftQualitySections(qualityGate);
  const artifact = {
    id: artifactId,
    title: "Generated SAP development draft",
    type: "text/markdown",
    content: `# JDAP Development Draft\n\n## Execution context\n- AI provider: ${aiProvider.toUpperCase()}\n- SAP target: ${system.name} (${system.release}) — MOCK ONLY\n- Selected specialists: ${selectedAgents.map(agent => agent.name).join(", ")}\n- SAP development repository: not accessed; no SAP object writes occurred\n${liveContextNote}\n## Requirement\n${prompt}\n\n${qualitySections}${outputSections}\n\n${selectionTextsSection}---\n**Safety:** Draft only. No SAP repository write, activation, transport or deployment was performed.\n`
  };
  return { id: randomUUID(), status: "COMPLETED", aiProvider, sapConnectivity: sapContext ? "LIVE ODATA READ ONLY" : "MOCK ONLY", system, selectedAgents, activities, outputs, qualityGate, artifact, createdAt: new Date().toISOString() };
}
