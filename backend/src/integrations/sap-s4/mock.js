export const s4System = {
  id: "mock-s4",
  name: "S/4HANA Development (Mock)",
  type: "S4HANA",
  release: "S/4HANA 2023",
  mode: "MOCK",
  capabilities: ["CDS metadata fixture", "RAP service fixture", "ADT capability fixture", "Released API catalog fixture"]
};

export const s4Fixture = {
  artifacts: ["CDS view entities", "RAP behavior definitions", "OData V4 services"]
};
