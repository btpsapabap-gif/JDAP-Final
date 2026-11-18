export const btpSystem = {
  id: "mock-btp",
  name: "SAP BTP Subaccount (Mock)",
  type: "BTP",
  release: "BTP Cloud Foundry",
  mode: "MOCK",
  capabilities: ["Destination fixture", "CAP service fixture", "Cloud Foundry app fixture", "AI Core configuration fixture"]
};

export const btpFixture = {
  services: ["Destination", "Cloud Foundry", "API Management", "AI Core"]
};
