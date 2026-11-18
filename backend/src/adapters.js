const systems = [
  { id: "mock-ecc", name: "ECC Development (Mock)", type: "ECC", release: "ECC 6.0", mode: "MOCK", capabilities: ["DDIC metadata fixture","ABAP source fixture","RFC/BAPI catalog fixture","OData catalog fixture"] },
  { id: "mock-s4", name: "S/4HANA Development (Mock)", type: "S4HANA", release: "S/4HANA 2023", mode: "MOCK", capabilities: ["CDS metadata fixture","RAP service fixture","ADT capability fixture","Released API catalog fixture"] },
  { id: "mock-btp", name: "SAP BTP Subaccount (Mock)", type: "BTP", release: "BTP Cloud Foundry", mode: "MOCK", capabilities: ["Destination fixture","CAP service fixture","Cloud Foundry app fixture","AI Core configuration fixture"] }
];
export function listMockSystems() { return systems; }
export async function discoverMockSystem(id) {
  const s = systems.find(x => x.id === id);
  if (!s) throw new Error("Mock SAP system not found");
  return { ...s, discoveredAt: new Date().toISOString(), connectivity: "SIMULATED — no SAP connection was made" };
}
export const mockAdapters = {
  ecc: { discover: () => discoverMockSystem("mock-ecc"), tables: ["VBRK","VBRP","KNA1","MARA"], transactions: ["SE11","SE38","ST22","WE02"] },
  s4: { discover: () => discoverMockSystem("mock-s4"), artifacts: ["CDS view entities","RAP behavior definitions","OData V4 services"] },
  btp: { discover: () => discoverMockSystem("mock-btp"), services: ["Destination","Cloud Foundry","API Management","AI Core"] }
};
