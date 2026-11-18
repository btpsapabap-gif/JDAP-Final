export default {
  id: "debug", name: "Debugging Specialist", specialty: "Troubleshooting",
  description: "Analyzes error text, dumps and runtime symptoms.",
  mockResponse: () => JSON.stringify({ findings: [], otherHypotheses: ["Mock mode does not analyze the supplied dump or ABAP source; it cannot identify a verified cause or source line."], checks: ["Capture the full ST22 exception, source position, transaction, user, and timestamp.", "Correlate the dump with SM21, application log, and relevant interface logs.", "Reproduce in a non-production system using the smallest failing input."], targetEvidenceNeeded: ["Inspect the dump and source position in the target SAP system; no live SAP check was performed."] })
};
