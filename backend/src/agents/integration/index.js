export default {
  id: "integration", name: "Integration Specialist", specialty: "Interfaces",
  description: "Analyzes IDoc, RFC, BAPI, OData and REST integration patterns.",
  mockResponse: () => `Integration analysis:\n- Identify sender/receiver, message contract and direction.\n- Verify IDoc basic type/extension or released API.\n- Define mapping, retry, monitoring and idempotency.\n- Do not assume a live endpoint is configured.`
};
