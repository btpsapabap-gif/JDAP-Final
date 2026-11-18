import { checkAbapGrammar } from "./checker.js";

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

function grammarReleaseFor(system = {}) {
  const label = `${system.name || ""} ${system.release || ""}`;
  if (/S\/4HANA\s*2023/i.test(label)) return "v758";
  if (/S\/4HANA\s*2022/i.test(label)) return "v757";
  if (/S\/4HANA\s*2021/i.test(label)) return "v756";
  if (/EHP\s*8|ECC\s*6\.0.*7\.50/i.test(label)) return "v750";
  return "v750";
}

export function evaluateAbapDraft(sourceValue, system = {}) {
  const source = String(sourceValue || "").trim();
  const release = grammarReleaseFor(system);
  const blockers = [];
  const findings = [];
  let grammar;

  if (!source) {
    blockers.push({ code: "abap-source-missing", message: "No ABAP source could be extracted from the draft." });
  } else {
    if (!OBJECT_DECLARATION.test(source)) {
      blockers.push({ code: "repository-object-declaration-missing", message: "ABAP source must start with a repository object declaration such as REPORT, CLASS, or INTERFACE." });
    }
    if (PLACEHOLDER.test(source)) {
      blockers.push({ code: "placeholder-or-assumption-code", message: "The source contains placeholder or ASSUME content; replace it with concrete, verified ABAP before review." });
    }
    if (/\bSELECT\s+(?:SINGLE\s+)?\*\s+FROM\b/i.test(source)) {
      blockers.push({ code: "select-star", message: "SELECT * is blocked by JDAP's draft quality gate. Use an explicit field list and bounded selection criteria." });
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
      .filter(name => !/^[ZY]/.test(name)))];
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
