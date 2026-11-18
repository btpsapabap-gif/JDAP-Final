import { eccFixture, eccSystem } from "./sap-ecc/mock.js";
import { s4Fixture, s4System } from "./sap-s4/mock.js";
import { btpFixture, btpSystem } from "./sap-btp/mock.js";

const systems = [eccSystem, s4System, btpSystem];
export function listMockSystems() { return systems; }

export async function discoverMockSystem(id) {
  const system = systems.find(item => item.id === id);
  if (!system) throw new Error("Mock SAP system not found");
  return { ...system, discoveredAt: new Date().toISOString(), connectivity: "SIMULATED — no SAP connection was made" };
}

export const mockAdapters = {
  ecc: { ...eccFixture, discover: () => discoverMockSystem(eccSystem.id) },
  s4: { ...s4Fixture, discover: () => discoverMockSystem(s4System.id) },
  btp: { ...btpFixture, discover: () => discoverMockSystem(btpSystem.id) }
};
