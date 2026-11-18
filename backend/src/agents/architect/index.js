export default {
  id: "architect", name: "SAP Solution Architect", specialty: "Solution design",
  description: "Decomposes requirements, selects SAP patterns and creates an implementation plan.",
  mockResponse: ({ prompt }) => `Architecture assessment for: "${prompt}"\n- Confirm business rules and acceptance criteria.\n- Inspect available standard SAP APIs before custom development.\n- Keep persistence and UI concerns separate.\n- Validate target-release capabilities before selecting syntax.`
};
