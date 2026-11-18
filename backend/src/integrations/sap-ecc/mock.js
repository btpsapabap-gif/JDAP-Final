export const eccSystem = {
  id: "mock-ecc",
  name: "ECC Development (Mock)",
  type: "ECC",
  release: "ECC 6.0",
  mode: "MOCK",
  capabilities: ["DDIC metadata fixture", "ABAP source fixture", "RFC/BAPI catalog fixture", "OData catalog fixture"]
};

export const eccFixture = {
  tables: ["VBRK", "VBRP", "KNA1", "MARA"],
  transactions: ["SE11", "SE38", "ST22", "WE02"]
};
