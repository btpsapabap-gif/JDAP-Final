import architect from "./architect/index.js";
import abap from "./abap/index.js";
import cdsRap from "./cds-rap/index.js";
import fiori from "./fiori/index.js";
import integration from "./integration/index.js";
import debugging from "./debugging/index.js";
import testing from "./testing/index.js";
import codeReview from "./code-review/index.js";
import security from "./security/index.js";
import compatibility from "./compatibility/index.js";
import documentation from "./documentation/index.js";
import devops from "./devops/index.js";

export const specialists = [
  architect, abap, cdsRap, fiori, integration, debugging,
  testing, codeReview, security, compatibility, documentation, devops
];

export const AGENTS = specialists.map(({ mockResponse, ...profile }) => profile);
export function getSpecialist(id) {
  return specialists.find(agent => agent.id === id);
}
