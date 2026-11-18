import { randomUUID } from "node:crypto";
import { AGENTS } from "../agents/registry.js";
import { runAgent } from "../agents/runner.js";
import { discoverMockSystem } from "../integrations/sap-mock.js";
import { evaluateAbapDraft, expectedReportName, grammarReleaseFor, normalizeAbapAgentOutput, normalizeRepositoryDeclaration, renderDraftQualitySections } from "../integrations/abap-static/draft-quality.js";
import { checkAbapGrammar } from "../integrations/abap-static/checker.js";
import { buildS4BillingExtractTemplate, isS4BillingExtractRequest } from "../integrations/abap-static/billing-extract-template.js";
import { buildS4PurchaseOrderReportTemplate, isS4PurchaseOrderReportRequest } from "../integrations/abap-static/purchase-order-template.js";
import { deriveSelectionTexts, selectionScreenDeclarations } from "../integrations/abap-static/selection-texts.js";

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
  const task = String(prompt || "");
  const asksToCreateSource = /\b(create|generate|build|write|develop|implement)\b[\s\S]{0,60}\b(?:abap|report|program|source|code)\b/i.test(task)
    && !/\b(?:do\s+not|don't|never)\s+(?:create|generate|build|write|develop|implement)\b/i.test(prompt);
  // A focused code-review request should not fan out to unrelated specialties
  // just because the submitted source contains words such as CDS, security,
  // release, or testing in comments.
  if (/\b(review|analy[sz]e|audit|inspect|assess)\b/i.test(task)
    && /\b(?:abap|report|program|source|code)\b/i.test(task)
    && !asksToCreateSource) {
    return AGENTS.filter(agent => agent.id === "review").map(({ id, name }) => ({ id, name }));
  }
  const selected = new Set();
  if (asksToCreateSource && /\b(?:abap|report|program|source|code)\b/i.test(task)) selected.add("abap");
  const asksForArchitecture = /\barchitect\b|\b(?:design|create|prepare|review)\b[\s\S]{0,35}\b(?:architecture|solution design|system design|end-to-end design)\b/i.test(task);
  if (asksForArchitecture) selected.add("architect");

  // Select additional specialists only when the request asks for their
  // deliverable. Merely mentioning CDS, authorization, S/4, or a test plan as
  // constraints inside an ABAP requirement should not fan out the workflow.
  if (/\b(?:create|build|design|implement|review|analy[sz]e)\b[\s\S]{0,45}\b(?:cds|rap|behavior definition|service definition|business object)\b/i.test(task)) selected.add("cds-rap");
  if (/\b(?:create|build|develop|review|design)\b[\s\S]{0,45}\b(?:fiori|sapui5|ui5|user interface|list report|object page)\b/i.test(task)) selected.add("fiori");
  if (/\b(?:create|design|implement|review|troubleshoot)\b[\s\S]{0,45}\b(?:idoc|rfc|bapi|odata|api|interface|integration)\b/i.test(task)) selected.add("integration");
  if (/\b(?:debug|troubleshoot|analy[sz]e)\b[\s\S]{0,45}\b(?:dump|error|incident|runtime issue)\b/i.test(task)) selected.add("debug");

  if (/\b(?:create|write|prepare|provide|run|execute)\b[\s\S]{0,45}\b(?:test plan|test cases|testing|regression tests|qa validation)\b/i.test(task)) selected.add("testing");
  if (/\b(?:perform|conduct|create|write|prepare)\b[\s\S]{0,45}\b(?:security review|security assessment|threat model|authorization review)\b/i.test(task)) selected.add("security");
  if (/\b(?:perform|conduct|create|write|prepare)\b[\s\S]{0,45}\b(?:code review|refactor|performance review|maintainability review)\b/i.test(task)) selected.add("review");
  if (/\b(?:perform|conduct|create|write|prepare)\b[\s\S]{0,45}\b(?:compatibility review|release compatibility|compatibility matrix|release assessment)\b/i.test(task)) selected.add("compatibility");
  if (/\b(?:create|write|prepare|provide)\b[\s\S]{0,45}\b(?:technical documentation|technical handover|readme|user guide)\b/i.test(task)) selected.add("documentation");
  if (/\b(?:create|design|implement|review)\b[\s\S]{0,45}\b(?:devops|deployment pipeline|ci\/cd|delivery pipeline)\b/i.test(task)) selected.add("devops");

  if (selected.size === 0) {
    selected.add("architect");
  }

  return AGENTS.filter(agent => selected.has(agent.id)).map(({ id, name }) => ({ id, name }));
}

function normalizeSupportOutput(value = "") {
  const withoutFencedCode = String(value).replace(/```[\s\S]*?(?:```|$)/g, "");
  const abapCodeLine = /^\s*(?:REPORT\s+\w+|PROGRAM\s+\w+|SELECT(?:-OPTIONS)?\b|PARAMETERS?\b|DATA\s*:|TYPES\s*:|TABLES\s*:|CONSTANTS\s*:|(?:START|END)-OF-SELECTION\.|AUTHORITY-CHECK\b|LOOP AT\b|ENDLOOP\b|IF\b|ENDIF\b)/i;
  const paragraphs = withoutFencedCode.split(/\n\s*\n/).filter(paragraph => {
    const codeLines = paragraph.split(/\r?\n/).filter(line => abapCodeLine.test(line));
    return codeLines.length < 2;
  });
  return paragraphs.join("\n\n").trim().slice(0, 5000);
}

function enforceMockEvidenceLimits(value = "") {
  const unsupportedEvidence = /(?:clean[ -]?core\s+level\s*(?:[0-4]|[A-D])|(?:released?\s+)?(?:api|release)\s+contracts?[^\n]{0,100}\b(?:verified|confirmed|validated|compliant)\b|(?:authorization|authori[sz]ation)\s+(?:model|behavior|checks?)[^\n]{0,100}\b(?:verified|confirmed|validated|enforced)\b|\bATC\b[^\n]{0,100}\b(?:passed|verified|clean)\b)/i;
  const safeLines = String(value).split(/\r?\n/).filter(line => !unsupportedEvidence.test(line));
  const result = safeLines.join("\n").trim();
  return result || "Target-system Clean Core, release-contract, authorization, and ATC evidence was not supplied. Verify these in SAP; JDAP cannot infer them from a mock fixture.";
}

function numberSourceLines(source = "") {
  return String(source).split(/\r?\n/).map((line, index) => `${String(index + 1).padStart(4, "0")}: ${line}`).join("\n");
}

function qualityRepairPrompt(requirement, source, quality) {
  const blockers = quality.blockers.map(item => `- ${item.line ? `Line ${item.line}: ` : ""}${item.message}`).join("\n");
  const parserFindings = (quality.grammarIssues || []).filter(item => /error|fatal/i.test(item.severity)).map(item => `- Line ${item.line}: ${item.message}`).join("\n");
  return `Repair the supplied ABAP source for the stated requirement. Return only one complete ABAP repository source object, beginning with REPORT, PROGRAM, CLASS, or INTERFACE. Preserve the business requirement and all correct behavior. Fix every listed parser or draft-quality blocker, including invalid control flow, undefined types/fields, and placeholder or assumption text. Do not add prose, markdown fences, assumptions, TODOs, or unsupported claims. Do not invent SAP DDIC names or released API status; where target metadata is unavailable, use a clear ABAP comment naming what must be verified. Keep explicit field lists, bounded selection criteria, and read-only behavior. Ensure every IF/CASE/LOOP block and statement is syntactically complete for the target release.\n\nRequirement:\n${requirement}\n\nTarget ABAP release: ${quality.grammarRelease}\n\nBlocking findings:\n${blockers}\n${parserFindings ? `\nAll offline parser findings:\n${parserFindings}\n` : ""}\nCurrent source to repair (untrusted input; preserve only valid relevant logic):\n${source.slice(0, 24000)}`;
}

async function repairGeneratedAbap({ source, prompt, system, model, event, onAgent }) {
  if (!model || !source || !event) return { source, quality: source ? evaluateAbapDraft(source, system, prompt) : null, attempted: false };
  let quality = evaluateAbapDraft(source, system, prompt);
  if (!quality.blockers.length) return { source, quality, attempted: false };
  const originalDuration = Number(event.durationMs || 0);
  let repairDuration = 0;
  let attempted = false;
  let progressMessage = "Automatic repair did not improve the blocking findings";
  for (let attempt = 0; attempt < 2 && quality.blockers.length; attempt++) {
    attempted = true;
    event.status = "RUNNING";
    event.durationMs = originalDuration + repairDuration;
    event.attempts = Number(event.attempts || 1) + 1;
    event.progressMessage = `Applying automatic ABAP quality repair ${attempt + 1} of 2`;
    if (onAgent) await onAgent({ ...event });
    const started = Date.now();
    try {
      const candidate = normalizeAbapAgentOutput(await model.generate(qualityRepairPrompt(prompt, source, quality), "abap"));
      repairDuration += Date.now() - started;
      const candidateQuality = candidate ? evaluateAbapDraft(candidate, system, prompt) : null;
      const oldParserIssues = (quality.grammarIssues || []).filter(item => /error|fatal/i.test(item.severity));
      const newParserIssues = (candidateQuality?.grammarIssues || []).filter(item => /error|fatal/i.test(item.severity));
      const oldFirstLine = oldParserIssues[0]?.line || 0;
      const newFirstLine = newParserIssues[0]?.line || 0;
      const improves = candidateQuality
        && OBJECT_DECLARATION.test(candidate)
        && !candidateQuality.blockers.some(item => item.code === "placeholder-or-assumption-code")
        && (candidateQuality.blockers.length < quality.blockers.length
          || (oldParserIssues.length > 0 && newParserIssues.length === 0)
          || newParserIssues.length < oldParserIssues.length
          || (oldFirstLine > 0 && newFirstLine > oldFirstLine));
      if (!improves) break;
      source = candidate;
      quality = candidateQuality;
      progressMessage = quality.blockers.length ? "Repair improved ABAP checks; checking remaining findings" : "Automatic ABAP repair cleared offline blockers";
    } catch (error) {
      repairDuration += Date.now() - started;
      progressMessage = `Automatic repair could not complete: ${error.message}`;
      break;
    }
  }
  event.status = "COMPLETED";
  event.durationMs = originalDuration + repairDuration;
  event.progressMessage = progressMessage;
  if (onAgent) await onAgent({ ...event, output: source });
  return { source, quality, attempted };
}

function identifierDistance(left = "", right = "") {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function validateSourceReviewOutput(value = "", source = "") {
  const text = String(value).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  let response;
  try { response = JSON.parse(json || text); } catch { response = null; }
  const sourceLines = String(source).split(/\r?\n/);
  const normalize = item => String(item || "").replace(/\s+/g, " ").trim().toLowerCase();
  const findings = Array.isArray(response?.findings) ? response.findings : [];
  const accepted = findings.filter(item => {
    const start = Number(item?.lineStart);
    const end = Number(item?.lineEnd ?? item?.lineStart);
    const evidence = String(item?.evidence || "").trim();
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > sourceLines.length || end - start > 9 || evidence.length < 6 || evidence.length > 500) return false;
    const excerpt = sourceLines.slice(start - 1, end).join(" ");
    return normalize(excerpt).includes(normalize(evidence)) && String(item?.finding || "").trim() && String(item?.recommendation || "").trim();
  });
  if (!accepted.length) return "JDAP accepted no source-specific findings: the model did not return line citations with exact, verifiable source quotes. Review the source manually; the offline quality gate and SAP Clean Core checks are separate.";
  const rendered = accepted.map((item, index) => `### ${index + 1}. ${String(item.finding).trim()}\n\n- Source: lines ${item.lineStart}–${item.lineEnd}, “${String(item.evidence).trim()}”\n- Recommendation: ${String(item.recommendation).trim()}`).join("\n\n");
  const rejectedCount = findings.length - accepted.length;
  return `${rendered}${rejectedCount ? `\n\nJDAP omitted ${rejectedCount} finding(s) without a matching source quote and line range.` : ""}`;
}

function validateDebugOutput(value = "", source = "", system = {}) {
  const sourceLines = String(source).split(/\r?\n/);
  const staticFindings = [];
  sourceLines.forEach((line, index) => {
    const match = line.match(/^\s*(?:CONSTANTS|DATA)\s+([A-Z][A-Z0-9_]*)\s+TYPE\s+i\s+VALUE\s+([+-]?[0-9][0-9_]*)\s*\./i);
    if (!match) return;
    let value;
    try { value = BigInt(match[2].replaceAll("_", "")); } catch { return; }
    if (value >= -2147483648n && value <= 2147483647n) return;
    const correctionValue = match[1].toLowerCase() === "gc_max_rows" ? "501" : "2147483647";
    staticFindings.push({
      title: "Integer value exceeds the ABAP type I range",
      lineStart: index + 1,
      lineEnd: index + 1,
      evidence: line.trim(),
      likelyCause: `\`${match[1]}\` is declared TYPE i, whose signed range is -2,147,483,648 to 2,147,483,647. The supplied value is outside that range. This is a confirmed source defect; the dump's exact failing statement is still needed to prove it caused this particular runtime error.`,
      correction: match[1].toLowerCase() === "gc_max_rows" ? "The report rejects results above 500 rows, so use 501 as the one-row-over-limit sentinel." : "Use a value within TYPE i's range or choose a numeric type sized for the requirement.",
      correctedSnippet: line.replace(match[2], correctionValue),
      confidence: "high"
    });
  });
  const declaredNames = new Set();
  const declarationPattern = /\b(?:DATA|PARAMETERS|SELECT-OPTIONS|CONSTANTS|STATICS|RANGES|FIELD-SYMBOLS)\s*:?\s+([A-Z][A-Z0-9_]*)/gi;
  for (const match of String(source).matchAll(declarationPattern)) declaredNames.add(match[1].toLowerCase());
  for (const match of String(source).matchAll(/\bDATA\s*\(\s*([A-Z][A-Z0-9_]*)\s*\)/gi)) declaredNames.add(match[1].toLowerCase());
  sourceLines.forEach((line, index) => {
    if (/^\s*\*/.test(line)) return;
    for (const match of line.matchAll(/@([A-Z][A-Z0-9_]*)/gi)) {
      const hostName = match[1].toLowerCase();
      if (hostName === "data" || declaredNames.has(hostName)) continue;
      const candidates = [...declaredNames].filter(name => identifierDistance(hostName, name) === 1);
      if (candidates.length !== 1) continue;
      const correctionName = candidates[0];
      const correctedLine = line.replace(new RegExp(`@${hostName}\\b`, "i"), `@${correctionName}`);
      staticFindings.push({
        title: "Undeclared SQL host variable",
        lineStart: index + 1,
        lineEnd: index + 1,
        evidence: line.trim(),
        likelyCause: `Open SQL references \`@${hostName}\`, but no ABAP declaration with that name was found. The source declares \`${correctionName}\`, which differs by one character. This matches a syntax-error cause; confirm the location with SAP's syntax check.`,
        correction: `Change \`@${hostName}\` to the declared parameter \`@${correctionName}\`.`,
        correctedSnippet: correctedLine.trim(),
        confidence: "high"
      });
    }
  });
  // Run the same offline parser used by the draft quality gate on every
  // supplied source, so ordinary syntax faults are caught without new
  // one-off rules for each reported typo.
  if (source.trim()) {
    try {
      const grammar = checkAbapGrammar(source, grammarReleaseFor(system));
      const alreadyReportedLines = new Set(staticFindings.map(item => item.lineStart));
      for (const issue of grammar.issues.filter(item => /error|fatal/i.test(item.severity))) {
        if (alreadyReportedLines.has(issue.line)) continue;
        const evidence = sourceLines[issue.line - 1]?.trim();
        if (!evidence) continue;
        staticFindings.push({
          title: "ABAP syntax error",
          lineStart: issue.line,
          lineEnd: issue.line,
          evidence,
          likelyCause: issue.message,
          correction: "Correct this statement to address the parser finding, then rerun Debug Center and the target SAP syntax check.",
          confidence: "high"
        });
        alreadyReportedLines.add(issue.line);
      }
    } catch (error) {
      staticFindings.push({
        title: "Offline ABAP syntax check unavailable",
        lineStart: 1,
        lineEnd: 1,
        evidence: sourceLines[0]?.trim() || "",
        likelyCause: error.message,
        correction: "Check the source with a supported ABAP release or run the syntax check in the target SAP system.",
        confidence: "review"
      });
    }
  }
  const text = String(value).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidate = text.match(/\{[\s\S]*\}/)?.[0] || text;
  let response;
  try { response = JSON.parse(candidate); } catch { response = null; }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    const verified = staticFindings.map((item, index) => `### ${index + 1}. ${item.title} — line ${item.lineStart} (high confidence)\n\n- **Evidence:** \`${item.evidence}\`\n- **Likely cause:** ${item.likelyCause}\n- **Correction:** ${item.correction}\n\n\`\`\`abap\n${item.correctedSnippet}\n\`\`\``).join("\n\n");
    return `${verified ? `### Source-linked findings\n${verified}\n\n` : ""}JDAP could not validate the model's response structure or source citations. Treat this model output as unverified and check it against the supplied evidence:\n\n${String(value).trim().slice(0, 5000)}`;
  }
  const normalize = item => String(item || "").replace(/\s+/g, " ").trim().toLowerCase();
  const findings = Array.isArray(response.findings) ? response.findings : [];
  const acceptedModelFindings = findings.filter(item => {
    const start = Number(item?.lineStart);
    const end = Number(item?.lineEnd ?? item?.lineStart);
    const evidence = String(item?.evidence || "").trim();
    if (!source || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > sourceLines.length || end - start > 7 || evidence.length < 6 || evidence.length > 300) return false;
    const excerpt = sourceLines.slice(start - 1, end).join(" ");
    return normalize(excerpt).includes(normalize(evidence)) && String(item?.title || "").trim() && String(item?.likelyCause || "").trim() && String(item?.correction || "").trim();
  });
  const hasDeterministicSyntaxFinding = staticFindings.some(item => ["Undeclared SQL host variable", "ABAP syntax error"].includes(item.title));
  const staticKeys = new Set(staticFindings.map(item => `${item.lineStart}:${normalize(item.evidence)}`));
  const accepted = [...staticFindings, ...acceptedModelFindings.filter(item => !hasDeterministicSyntaxFinding && !staticKeys.has(`${Number(item.lineStart)}:${normalize(item.evidence)}`))];
  const sections = [];
  if (source) {
    sections.push("### Source-linked findings");
    if (accepted.length) {
      sections.push(accepted.map((item, index) => {
        const lineLabel = item.lineStart === item.lineEnd ? `line ${item.lineStart}` : `lines ${item.lineStart}–${item.lineEnd}`;
        const confidence = ["high", "medium", "low"].includes(String(item.confidence).toLowerCase()) ? String(item.confidence).toLowerCase() : "not stated";
        return `### ${index + 1}. ${String(item.title).trim()} — ${lineLabel} (${confidence} confidence)\n\n- **Evidence:** \`${String(item.evidence).trim()}\`\n- **Likely cause:** ${String(item.likelyCause).trim()}\n- **Correction:** ${String(item.correction).trim()}${item.correctedSnippet ? `\n\n\`\`\`abap\n${String(item.correctedSnippet).slice(0, 1000)}\n\`\`\`` : ""}`;
      }).join("\n\n"));
    } else {
      sections.push("JDAP could not verify a source-specific finding with an exact line citation and matching code quote. Treat unlinked possibilities as hypotheses only.");
    }
    if (hasDeterministicSyntaxFinding && acceptedModelFindings.length) sections.push("JDAP withheld the model's other source-linked findings because the offline ABAP checks found a concrete syntax issue; correct it and rerun the analysis.");
    else if (findings.length > acceptedModelFindings.length) sections.push(`JDAP omitted ${findings.length - acceptedModelFindings.length} model finding(s) whose line number or quoted evidence did not match the supplied source.`);
  } else {
    sections.push("### Source line references\nNo ABAP source was supplied, so JDAP cannot identify source line numbers. Attach the relevant source to get cited code findings.");
  }
  const appendList = (heading, items) => {
    if (Array.isArray(items) && items.some(item => String(item || "").trim())) sections.push(`### ${heading}\n${items.filter(item => String(item || "").trim()).slice(0, 8).map(item => `- ${String(item).trim().slice(0, 600)}`).join("\n")}`);
  };
  appendList("Other hypotheses (not tied to a source line)", response.otherHypotheses);
  appendList("Checks to distinguish causes", response.checks);
  appendList("Target-system evidence still needed", response.targetEvidenceNeeded);
  return sections.join("\n\n").slice(0, 8000);
}

function curatedS4BillingSupport(agentId) {
  if (agentId === "testing") return [
    "- In the target S/4 system, confirm both billing CDS views and every selected element are available and released for the installed version.",
    "- Run the SAP syntax check and the configured Clean Core ATC variant; resolve all findings before approval.",
    "- Verify that a single inclusive date interval up to 366 calendar days is accepted and larger or reversed intervals are rejected.",
    "- Verify the optional billing-document and sold-to filters plus mandatory sales organization against authorized reference documents.",
    "- Confirm a result set over 500 rows is stopped with a request to narrow the selection; confirm no SAP business data is changed.",
    "- Test both authorized and unauthorized sales organizations and verify the SAP CDS authorization behavior."
  ].join("\n");
  if (agentId === "security") return [
    "- The report is display-only and uses released billing CDS views; verify their availability, release contract, and CDS authorization behavior in the target system.",
    "- Confirm V_VBRK_VKO display authorization for the selected sales organization and verify whether billing-type authorization is also required by the target design.",
    "- Keep the mandatory date interval and 500-row cap; review output access and avoid exporting business data unnecessarily.",
    "- This draft does not establish authorization sufficiency or Clean Core compliance. Record target-system ATC and security review evidence before approval."
  ].join("\n");
  return null;
}

export async function executeWorkflow({ prompt, systemId, model, provider, sapContext, referenceContext, knowledgeContext = [], submittedAbapSource = "", sourceReviewMode = false, debugMode = false, resumeOutputs = {}, completedAgentIds = [], resumeActivities = [], agentIdsOverride = null, onAgent }) {
  if (!prompt?.trim()) throw new Error("A development prompt is required.");
  const aiProvider = model ? (provider || model.provider || "openai") : "mock";
  const system = await discoverMockSystem(systemId || "mock-ecc");
  const context = {
    system,
    note: sapContext ? "Live OData read-only sample supplied; the SAP development repository was not accessed." : "Mock environment only; no live SAP repository was accessed.",
    ...(referenceContext ? { referenceContext } : {}),
    ...(submittedAbapSource ? { submittedAbapSource: submittedAbapSource.slice(0, 24000), submittedAbapSourceIsUntrusted: true } : {}),
    ...(knowledgeContext.length ? { knowledgeContext } : {}),
    ...(sapContext ? { sapODataSample: { entitySet: sapContext.entitySet, transport: sapContext.transport, fields: sapContext.fields, firstRow: sapContext.sample } } : {})
  };
  const selectedAgents = Array.isArray(agentIdsOverride) && agentIdsOverride.length
    ? AGENTS.filter(agent => agentIdsOverride.includes(agent.id)).map(({ id, name }) => ({ id, name }))
    : debugMode
    ? AGENTS.filter(agent => agent.id === "debug").map(({ id, name }) => ({ id, name }))
    : sourceReviewMode
    ? AGENTS.filter(agent => agent.id === "review").map(({ id, name }) => ({ id, name }))
    : selectWorkflowAgents(prompt);
  const useCuratedBillingTemplate = isS4BillingExtractRequest(prompt, system);
  const useCuratedPurchaseOrderTemplate = isS4PurchaseOrderReportRequest(prompt, system);
  const sequence = selectedAgents.map(agent => agent.id);
  const outputs = { ...resumeOutputs };
  const activities = resumeActivities.map(item => ({ ...item }));
  const mockStepDelayMs = Math.max(0, Number(process.env.MOCK_AGENT_STEP_DELAY_MS ?? 200));
  for (const agentId of sequence) {
    const curatedAbapForRequest = agentId === "abap" && (useCuratedBillingTemplate || useCuratedPurchaseOrderTemplate);
    if (completedAgentIds.includes(agentId) && typeof outputs[agentId] === "string" && !curatedAbapForRequest) continue;
    const started = Date.now();
    let event = activities.find(item => item.agentId === agentId);
    if (event) {
      event = { ...event, status: "RUNNING", durationMs: 0, attempts: Number(event.attempts || 1) + 1 };
      activities[activities.findIndex(item => item.agentId === agentId)] = event;
    } else {
      event = { agentId, name: AGENTS.find(a => a.id === agentId).name, status: "RUNNING", durationMs: 0, attempts: 1 };
      activities.push(event);
    }
    if (onAgent) await onAgent(event);
    if (!model && mockStepDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, mockStepDelayMs));
    }
    const priorAgentWork = Object.fromEntries((HANDOFFS[agentId] || [])
      .filter(priorId => outputs[priorId])
      .map(priorId => [priorId, outputs[priorId].slice(0, 1600)]));
    const agentContext = { ...context, priorAgentWork };
    if (sourceReviewMode && agentId === "review") {
      agentContext.submittedAbapSource = numberSourceLines(submittedAbapSource);
      agentContext.sourceReviewEvidenceRule = "Each source-specific finding must cite numbered line(s) and quote a short exact source fragment. Do not report a construct unless it appears in the supplied source. Do not claim SELECT * unless that exact SQL construct is present. Keep target-system evidence as unverified.";
    }
    if (sapContext && !["architect", "abap"].includes(agentId)) delete agentContext.sapODataSample;
    const useCuratedAbapTemplate = useCuratedBillingTemplate || useCuratedPurchaseOrderTemplate;
    const curatedSupport = useCuratedBillingTemplate ? curatedS4BillingSupport(agentId) : null;
    const output = agentId === "abap" && useCuratedAbapTemplate
      ? useCuratedPurchaseOrderTemplate
        ? buildS4PurchaseOrderReportTemplate(prompt, referenceContext?.programName)
        : buildS4BillingExtractTemplate(prompt, referenceContext?.programName)
      : curatedSupport || await runAgent(agentId, { prompt, system, context: agentContext }, model);
    const normalizedOutput = agentId === "abap" ? normalizeAbapAgentOutput(output) : agentId === "debug" ? validateDebugOutput(output, submittedAbapSource, system) : normalizeSupportOutput(output);
    const groundedOutput = sourceReviewMode && agentId === "review"
      ? validateSourceReviewOutput(output, submittedAbapSource)
      : normalizedOutput;
    outputs[agentId] = enforceMockEvidenceLimits(groundedOutput);
    event.status = "COMPLETED";
    event.durationMs = Date.now() - started;
    if (onAgent) await onAgent({ ...event, output: outputs[agentId] });
  }
  const artifactId = randomUUID();
  const reviewedSource = sourceReviewMode ? submittedAbapSource : "";
  const selectionSource = outputs.abap || reviewedSource;
  const declaredSelectionNames = selectionScreenDeclarations(selectionSource);
  const derivedSelectionTexts = deriveSelectionTexts(selectionSource);
  const selectionTexts = derivedSelectionTexts.length === declaredSelectionNames.length ? derivedSelectionTexts : [];
  const selectionTextsSection = selectionTexts.length
    ? `## Selection screen texts\n\n${selectionTexts.map(([name, label]) => `- ${name}: ${label}`).join("\n")}\n\n`
    : "";
  const liveContextNote = sapContext
    ? `\n## Live SAP data context\n- OData entity set: ${sapContext.entitySet}\n- Transport: ${sapContext.transport}\n- First-row fields supplied to agents: ${sapContext.fields.join(", ")}\n- SAP returned ${sapContext.rowsReceived} row(s) for a $top=1 request; JDAP retained only the first row.\n- A live data row was included in agent context; review generated content for sensitive values before sharing.\n`
    : "";
  const referenceContextNote = referenceContext
    ? `\n## Approved JDAP reference\n- Prior workflow: ${referenceContext.workflowId}\n- Artifact: ${referenceContext.title}\n- Prior report name: ${referenceContext.programName || "not detected"}\n- Prior selection labels: ${referenceContext.selectionLabels || "none recorded"}\n- Source included for continuity: ${referenceContext.approvedSource ? (useCuratedBillingTemplate ? "not used by the curated ABAP generator" : "yes") : "no"}${referenceContext.sourceTruncatedForContext && !useCuratedBillingTemplate ? " (source excerpt limited to 6,000 characters)" : ""}\n- This is user-selected context; the current requirement takes precedence.\n`
    : "";
  const knowledgeContextNote = knowledgeContext.length
    ? `\n## Knowledge Hub references\n${knowledgeContext.map(source => `- [KH:${source.id}] ${source.title} — ${source.domain}/${source.filename} (${source.sourceName})`).join("\n")}\n- These are approved local JDAP working guides supplied as reference. Verify SAP-specific behavior and release contracts in the target system.\n`
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
  const continuityRequirement = referenceContext?.programName && !expectedReportName(prompt)
    ? `${prompt}\nThe program name is ${referenceContext.programName}. Preserve it unless the current requirement explicitly specifies a different report name.`
    : prompt;
  let abapRepair = null;
  const useCuratedAbapTemplate = useCuratedBillingTemplate || useCuratedPurchaseOrderTemplate;
  if (!sourceReviewMode && !debugMode && !useCuratedAbapTemplate && !completedAgentIds.includes("abap") && outputs.abap) {
    outputs.abap = normalizeRepositoryDeclaration(outputs.abap);
    if (model) {
      const abapActivity = activities.find(item => item.agentId === "abap");
      abapRepair = await repairGeneratedAbap({ source: outputs.abap, prompt: continuityRequirement, system, model, event: abapActivity, onAgent });
      outputs.abap = abapRepair.source;
    }
  }
  const qualitySource = sourceReviewMode ? submittedAbapSource : outputs.abap;
  const qualityGate = qualitySource ? evaluateAbapDraft(qualitySource, system, continuityRequirement) : null;
  const generationMode = debugMode ? "DEBUG_ANALYSIS" : sourceReviewMode ? "SOURCE_REVIEW" : useCuratedPurchaseOrderTemplate ? "CURATED_S4_PURCHASE_ORDER_TEMPLATE" : useCuratedBillingTemplate ? "CURATED_S4_BILLING_TEMPLATE" : "MODEL_GENERATED";
  const qualitySections = renderDraftQualitySections(qualityGate);
  const artifact = {
    id: artifactId,
    title: "Generated SAP development draft",
    type: "text/markdown",
    content: `# JDAP Development Draft\n\n## Execution context\n- AI provider: ${aiProvider.toUpperCase()}\n- SAP target: ${system.name} (${system.release}) — MOCK ONLY\n- Selected specialists: ${selectedAgents.map(agent => agent.name).join(", ")}\n- SAP development repository: not accessed; no SAP object writes occurred\n${sourceReviewMode ? "- Workflow mode: source review; JDAP did not generate replacement ABAP\n" : ""}${useCuratedBillingTemplate ? "- ABAP generation: curated S/4 billing extraction template; the local model did not generate the ABAP source\n" : ""}${liveContextNote}${referenceContextNote}${knowledgeContextNote}\n## Requirement\n${prompt}\n\n${submittedAbapSource ? `## ABAP source under review\n\n\`\`\`abap\n${submittedAbapSource.slice(0, 24000)}\n\`\`\`\n\n` : ""}${qualitySections}${outputSections}\n\n${selectionTextsSection}---\n**Safety:** Draft only. No SAP repository write, activation, transport or deployment was performed. Mock fixtures and local model output are not evidence of SAP API release status, authorization behavior, ATC results, or Clean Core compliance.\n`
  };
  return { id: randomUUID(), status: "COMPLETED", aiProvider, generationMode, sapConnectivity: sapContext ? "LIVE ODATA READ ONLY" : "MOCK ONLY", system, selectedAgents, activities, outputs, qualityGate, referenceWorkflowId: referenceContext?.workflowId || null, knowledgeReferences: knowledgeContext.map(({ excerpt, score, ...source }) => source), artifact, createdAt: new Date().toISOString() };
}
