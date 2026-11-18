import { checkAbapGrammar } from "./checker.js";
import { selectionScreenDeclarations } from "./selection-texts.js";

const OBJECT_DECLARATION = /^\s*(?:REPORT|PROGRAM|CLASS|INTERFACE|FUNCTION-POOL|DEFINE)\b/im;
const PLACEHOLDER = /\b(?:TODO|TBD|PLACEHOLDER|ASSUME)\b|\bASSUMPTIONS?\s*:|replace\s+(?:this|with)|not\s+implemented|your\s+code\s+here/i;

function sourceFromSection(section) {
  const lines = String(section || "").split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*(?:REPORT|PROGRAM|CLASS|INTERFACE|FUNCTION-POOL|DEFINE)\b/i.test(line));
  if (start < 0) return lines.filter(line => !/^\s*```(?:abap)?\s*$/i.test(line)).join("\n").trim();
  const tail = lines.slice(start);
  const end = tail.findIndex((line, index) => index > 0 && /^\s*```\s*$/.test(line));
  return tail.slice(0, end > 0 ? end : undefined).join("\n").trim();
}

export function extractAbapSource(markdown = "") {
  const section = String(markdown).match(/##\s+ABAP draft\s*([\s\S]*?)(?=\n##\s|\n---\s*$|$)/i)?.[1] || "";
  return sourceFromSection(section);
}

export function normalizeAbapAgentOutput(value = "") {
  return sourceFromSection(String(value).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
}

export function normalizeRepositoryDeclaration(sourceValue = "") {
  const source = String(sourceValue || "");
  const lines = source.split("\n");
  const reportLine = lines.findIndex(line => /^\s*REPORT\b/i.test(line));
  if (reportLine < 0) return source;
  if (/^\s*REPORT\s+[A-Z][A-Z0-9_]{0,29}(?=\s|\.|$)/i.test(lines[reportLine])) return source;
  lines[reportLine] = lines[reportLine].replace(/^\s*REPORT\b.*$/i, "REPORT z_jdap_generated.");
  return lines.join("\n");
}

export function expectedReportName(requirement = "") {
  const text = String(requirement || "");
  const match = text.match(/\b(?:report|program)\s+(?:named|called)\s+(Z[A-Z0-9_]{1,39})\b/i)
    || text.match(/\bprogram\s+name\s+(?:as|is)\s+(Z[A-Z0-9_]{1,39})\b/i);
  return match?.[1]?.toUpperCase() || null;
}

export function grammarReleaseFor(system = {}) {
  const label = `${system.name || ""} ${system.release || ""}`;
  if (/S\/4HANA\s*2023/i.test(label)) return "v758";
  if (/S\/4HANA\s*2022/i.test(label)) return "v757";
  if (/S\/4HANA\s*2021/i.test(label)) return "v756";
  if (/EHP\s*8|ECC\s*6\.0.*7\.50/i.test(label)) return "v750";
  return "v750";
}

export function evaluateAbapDraft(sourceValue, system = {}, requirement = "") {
  const source = String(sourceValue || "").trim();
  const release = grammarReleaseFor(system);
  const blockers = [];
  const findings = [];
  let grammar;
  const expectedName = expectedReportName(requirement);
  const actualName = source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z][A-Z0-9_]*)/im)?.[1]?.toUpperCase() || null;

  if (!source) {
    blockers.push({ code: "abap-source-missing", message: "No ABAP source could be extracted from the draft." });
  } else {
    const finalStatement = source.split("\n").at(-1)?.trim() || "";
    if (/(?:=\s*abap|=\s*|\b(?:SELECT|WHERE|AND|OR|INTO|FROM|TYPE|DATA)\s*)$/i.test(finalStatement)) {
      blockers.push({ code: "abap-source-truncated", line: source.split("\n").length, message: `The ABAP output ends with an incomplete statement (“${finalStatement}”). The model response was likely truncated; this draft cannot be approved or sent to SAP.` });
    }
    if (!OBJECT_DECLARATION.test(source)) {
      blockers.push({ code: "repository-object-declaration-missing", message: "ABAP source must start with a repository object declaration such as REPORT, CLASS, or INTERFACE." });
    }
    const reportLine = source.split("\n").findIndex(line => /^\s*REPORT\b/i.test(line));
    if (reportLine >= 0 && !/^\s*REPORT\s+[A-Z][A-Z0-9_]{0,29}(?=\s|\.|$)/i.test(source.split("\n")[reportLine])) {
      blockers.push({ code: "invalid-report-name", line: reportLine + 1, message: "REPORT requires a valid ABAP program name of at most 30 characters (letters, digits, and underscores)." });
    }
    if (expectedName && actualName && expectedName !== actualName) {
      blockers.push({ code: "program-name-mismatch", message: `The requirement specifies ${expectedName}, but the ABAP declaration is ${actualName}. JDAP requires an exact program-name match.` });
    }
    if (PLACEHOLDER.test(source)) {
      blockers.push({ code: "placeholder-or-assumption-code", message: "The source contains placeholder or ASSUME content; replace it with concrete, verified ABAP before review." });
    }
    for (const declaration of selectionScreenDeclarations(source).filter(item => item.name.length > 8)) {
      blockers.push({ code: "selection-name-too-long", line: declaration.line, message: `Selection-screen name ${declaration.name} exceeds ABAP's eight-character limit. Shorten the identifier before approval.` });
    }
    if (/\bSELECT\s+(?:SINGLE\s+)?\*[^.\n]{0,240}\bFROM\b/i.test(source)) {
      blockers.push({ code: "select-star", message: "SELECT * is blocked by JDAP's draft quality gate. Use an explicit field list and bounded selection criteria." });
    }
    if (/\b(?:display[- ]only|must not create or change|read[- ]only)\b/i.test(requirement)) {
      const writeMatch = source.match(/^\s*(?:INSERT\s+\w+\s+FROM|UPDATE\s+\w+|MODIFY\s+\w+|DELETE\s+FROM\s+\w+)\b/im);
      if (writeMatch) {
        const line = source.slice(0, writeMatch.index).split("\n").length;
        blockers.push({ code: "write-operation-in-display-only-report", line, message: "The requirement is display-only, but the source contains a database write statement. Remove the write operation; this report must not change SAP data." });
      }
    }

    try {
      grammar = checkAbapGrammar(source, release);
      for (const issue of grammar.issues.filter(item => /error|fatal/i.test(item.severity))) {
        blockers.push({ code: "abap-grammar-error", line: issue.line, message: issue.message });
      }
    } catch (error) {
      blockers.push({ code: "abap-grammar-check-failed", message: error.message });
    }

    const sapObjects = [...new Set([...source.matchAll(/\b(?:FROM|JOIN)\s+([A-Z][A-Z0-9_/]*)/gi)]
      .map(match => match[1].toUpperCase())
      .filter(name => !/^[ZY]/.test(name) && !/^(?:LT|GT|IT|CT|MT)_[A-Z0-9_]+$/.test(name)))];
    if (sapObjects.length) {
      findings.push({
        code: "sap-api-release-unverified",
        severity: "review",
        objects: sapObjects,
        message: `The source reads SAP repository objects (${sapObjects.join(", ")}). JDAP cannot verify their release contracts offline. Prefer released APIs/CDS views and confirm each dependency with the target system's Clean Core ATC checks.`
      });
    }
    if (/\b(?:AUTHORITY-CHECK|WITH\s+PRIVILEGED\s+ACCESS)\b/i.test(source) === false && sapObjects.length) {
      findings.push({
        code: "authorization-review-required",
        severity: "review",
        message: "No explicit authorization control was detected in the source. Confirm that the chosen released data source enforces the required authorization model; add an explicit check where required."
      });
    }
  }

  const cleanCore = {
    status: "SAP_ATC_REQUIRED",
    target: system.release || "target release not recorded",
    level: "NOT_CLASSIFIED",
    findings: [
      ...findings,
      {
        code: "clean-core-atc-required",
        severity: "review",
        message: "Offline grammar and source screening cannot establish ABAP language version, API release contracts, extension-point use, or a Clean Core Level. Run the configured SAP Clean Core ATC variant in the target system before claiming compliance."
      }
    ],
    note: "JDAP does not claim Clean Core compliance or assign a Clean Core Level from offline checks."
  };

  return {
    state: blockers.length ? "BLOCKED" : "READY_FOR_REVIEW",
    expectedProgramName: expectedName,
    actualProgramName: actualName,
    grammarRelease: release,
    grammarState: grammar?.state || (source ? "check-failed" : "not-run"),
    grammarIssues: grammar?.issues || [],
    blockers,
    cleanCore,
    sourceLineCount: source ? source.split("\n").length : 0
  };
}

export function renderDraftQualitySections(quality) {
  if (!quality) return "";
  const blocking = quality.blockers.length
    ? quality.blockers.map(item => `- BLOCKED${item.line ? ` · line ${item.line}` : ""}: ${item.message}`).join("\n")
    : "- No blocking offline quality findings. Human review is still required.";
  const cleanCoreFindings = quality.cleanCore.findings.map(item => `- ${item.message}`).join("\n");
  return `## Draft quality gate\n\n- State: **${quality.state}**\n- Offline ABAP grammar: **${quality.grammarState}** (${quality.grammarRelease})\n${blocking}\n\n## SAP Clean Core screening\n\n- State: **${quality.cleanCore.status}**\n- Clean Core Level: **${quality.cleanCore.level}**\n${cleanCoreFindings}\n- ${quality.cleanCore.note}\n\n`;
}
