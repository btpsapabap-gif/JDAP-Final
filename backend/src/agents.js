export const AGENTS = [
  ["architect","SAP Solution Architect","Solution design","Decomposes requirements, selects SAP patterns and creates an implementation plan."],
  ["abap","ABAP Developer","ABAP engineering","Creates ABAP reports, classes, enhancements and function-module drafts."],
  ["cds-rap","CDS / RAP Developer","Data modeling","Drafts CDS entities, RAP behavior and service definitions."],
  ["fiori","Fiori Developer","User experience","Drafts SAPUI5 and Fiori Elements application structures."],
  ["integration","Integration Specialist","Interfaces","Analyzes IDoc, RFC, BAPI, OData and REST integration patterns."],
  ["debug","Debugging Specialist","Troubleshooting","Analyzes error text, dumps and runtime symptoms."],
  ["testing","Test Engineer","Quality assurance","Creates unit, integration and regression test scenarios."],
  ["review","Code Reviewer","Code quality","Reviews source drafts for maintainability, performance and correctness risks."],
  ["security","Security Specialist","Secure development","Checks authorization, secrets, injection and data exposure risks."],
  ["compatibility","Release Compatibility Specialist","ECC / S4 compatibility","Flags release-sensitive syntax and migration compatibility considerations."],
  ["documentation","Technical Writer","Documentation","Creates technical design notes and developer handover documentation."],
  ["devops","DevOps Specialist","Delivery engineering","Prepares Git, CI and release-readiness recommendations; no deployment execution."]
].map(([id,name,specialty,description]) => ({id,name,specialty,description}));

export async function runAgent(agentId, input, model) {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const prompt = `You are ${agent.name}, an SAP development specialist. Specialty: ${agent.specialty}.
Task: ${input.prompt}
Target system: ${JSON.stringify(input.system)}
Context: ${JSON.stringify(input.context || {})}
Use any prior-agent handoff as working context: build on relevant decisions, flag conflicts or missing information, and avoid repeating the full earlier output. Return concise, actionable output. Clearly label assumptions. Never claim to have connected to SAP or executed code.`;
  if (model) return await model.generate(prompt, agentId);
  return mockAgentOutput(agentId, input);
}

function mockAgentOutput(id, input) {
  const p = input.prompt;
  const billingExtract = /billing|invoice|vbrk|vbrp/i.test(p) && /report|extract|header|item/i.test(p);
  if (billingExtract && id === "abap") return billingReportDraft;
  if (billingExtract && id === "testing") return `Billing extraction test plan (draft):\n1. Run for an authorized sales organization and a narrow billing-date interval; compare document headers and items with VF03/VF05.\n2. Verify multiple invoices, multiple items, currencies, quantities and units; check header/item totals are not incorrectly aggregated.\n3. Verify an interval with no invoices returns an empty-result message.\n4. Verify missing date interval and missing sales organization are rejected by the selection screen.\n5. Verify a user without display authorization is denied.\n6. Test a high-volume interval in QA and agree a maximum date span or paging/ALV approach before production use.\n7. Regression-check totals and document counts against an approved standard report.\nNo tests were executed; validate field selection, authorization object and volume limits in the target ECC system.`;
  if (billingExtract && id === "review") return `Review findings for the billing extraction draft:\n- Uses an explicit VBRK/VBRP field list and requires sales organization plus billing-date selection to reduce accidental broad reads.\n- Checks display authorization before reading billing data; verify V_VBRK_VKO and required fields with the target system's SU21/PFCG configuration.\n- Header and item totals are displayed at their own levels; do not sum header totals across item rows.\n- The draft uses classic Open SQL patterns intended for ECC, but exact syntax, authorization behavior, output usability and runtime still require target-system validation.\n- Add an agreed maximum interval or ALV/paging strategy after measuring expected data volume.`;
  const map = {
    architect: `Architecture assessment for: "${p}"\n- Confirm business rules and acceptance criteria.\n- Inspect available standard SAP APIs before custom development.\n- Keep persistence and UI concerns separate.\n- Validate target-release capabilities before selecting syntax.`,
    abap: `ABAP draft guidance for: "${p}"\nREPORT z_jdap_generated.\n\n* Draft only — validate in the target ABAP system.\nPARAMETERS p_test AS CHECKBOX DEFAULT 'X'.\n\nSTART-OF-SELECTION.\n  WRITE: / 'JDAP generated ABAP draft'.\n  WRITE: / 'Replace this scaffold with validated business logic'.`,
    "cds-rap": `CDS/RAP design draft:\n- Define a CDS view entity over verified source entities.\n- Use explicit field lists and authorization annotations.\n- Add behavior definitions only for transactional requirements.\n- Publish through a service definition and binding where supported.`,
    fiori: `Fiori application draft:\n- Use Fiori Elements where a supported OData service exists.\n- Define list report/object page floorplan.\n- Add annotations, value helps and semantic navigation.\n- Keep UI logic thin and validate accessibility.`,
    integration: `Integration analysis:\n- Identify sender/receiver, message contract and direction.\n- Verify IDoc basic type/extension or released API.\n- Define mapping, retry, monitoring and idempotency.\n- Do not assume a live endpoint is configured.`,
    debug: `Troubleshooting approach:\n- Capture exact error, timestamp, user and transaction.\n- Correlate ST22, SM21, application log and interface monitor evidence.\n- Reproduce in non-production and isolate the smallest failing input.\n- No live dump was inspected by this mock agent.`,
    testing: `Test plan:\n1. Positive case with valid master and transaction data.\n2. Missing/invalid mandatory input.\n3. Authorization-negative case.\n4. Boundary volume and performance case.\n5. Regression against existing output and totals.`,
    review: `Review findings:\n- Draft scaffold is not production-ready.\n- Add explicit types, exception handling and authorization checks.\n- Avoid SELECT * and unbounded data reads.\n- Validate syntax and performance using target-system tools.`,
    security: `Security findings:\n- Enforce least-privilege authorization checks.\n- Validate all external inputs and avoid dynamic SQL injection.\n- Mask personal and financial data in logs.\n- Keep credentials outside source code and prompts.`,
    compatibility: `Compatibility notes for ${input.system?.release || "unknown release"}:\n- Verify syntax support and API release status in the actual system.\n- Prefer released interfaces for S/4HANA Cloud.\n- Treat ECC and S/4HANA data model differences explicitly.\n- This is a static mock assessment, not a simplification check.`,
    documentation: `Technical handover:\nPurpose: ${p}\nTarget: ${input.system?.name || "Unspecified mock system"}\nImplementation: Draft generated by JDAP mock agents.\nValidation: Must be completed in a connected development system.\nRisks: Release compatibility, authorizations, performance and regression.`,
    devops: `Delivery readiness:\n- Create a feature branch and commit source with traceable work item.\n- Require peer review and automated checks.\n- Package transport dependencies only after system validation.\n- Deployment and transport release are not available in this prototype.`
  };
  return map[id] || `Agent ${id} completed mock analysis for: ${p}`;
}

const billingReportDraft = `REPORT z_jdap_billing_extract.\n\n* Draft for ECC 6.0. Verify field availability, authorization design,\n* output requirements and performance in the target development system.\n\nTYPES: BEGIN OF ty_header,\n         vbeln TYPE vbrk-vbeln,\n         fkdat TYPE vbrk-fkdat,\n         kunag TYPE vbrk-kunag,\n         vkorg TYPE vbrk-vkorg,\n         waerk TYPE vbrk-waerk,\n         netwr TYPE vbrk-netwr,\n       END OF ty_header.\nTYPES: BEGIN OF ty_item,\n         vbeln TYPE vbrp-vbeln,\n         posnr TYPE vbrp-posnr,\n         matnr TYPE vbrp-matnr,\n         arktx TYPE vbrp-arktx,\n         fkimg TYPE vbrp-fkimg,\n         vrkme TYPE vbrp-vrkme,\n         netwr TYPE vbrp-netwr,\n       END OF ty_item.\n\nDATA: gt_header TYPE STANDARD TABLE OF ty_header,\n      gs_header TYPE ty_header,\n      gt_item   TYPE STANDARD TABLE OF ty_item,\n      gs_item   TYPE ty_item.\n\nSELECT-OPTIONS: s_fkdat FOR vbrk-fkdat OBLIGATORY,\n                s_vbeln FOR vbrk-vbeln,\n                s_kunag FOR vbrk-kunag.\nPARAMETERS: p_vkorg TYPE vbrk-vkorg OBLIGATORY.\n\nSTART-OF-SELECTION.\n  AUTHORITY-CHECK OBJECT 'V_VBRK_VKO'\n    ID 'VKORG' FIELD p_vkorg\n    ID 'ACTVT' FIELD '03'.\n  IF sy-subrc <> 0.\n    MESSAGE 'Not authorized to display billing documents for this sales organization' TYPE 'E'.\n  ENDIF.\n\n  SELECT vbeln fkdat kunag vkorg waerk netwr\n    INTO TABLE gt_header\n    FROM vbrk\n    WHERE vkorg = p_vkorg\n      AND fkdat IN s_fkdat\n      AND vbeln IN s_vbeln\n      AND kunag IN s_kunag.\n\n  IF gt_header IS INITIAL.\n    WRITE: / 'No billing documents match the selection.'.\n    RETURN.\n  ENDIF.\n\n  WRITE: / 'Billing document headers'.\n  LOOP AT gt_header INTO gs_header.\n    WRITE: / gs_header-vbeln, gs_header-fkdat, gs_header-kunag,\n             gs_header-vkorg, gs_header-netwr, gs_header-waerk.\n  ENDLOOP.\n\n  SELECT vbeln posnr matnr arktx fkimg vrkme netwr\n    INTO TABLE gt_item\n    FROM vbrp\n    FOR ALL ENTRIES IN gt_header\n    WHERE vbeln = gt_header-vbeln.\n\n  WRITE: / 'Billing document items'.\n  LOOP AT gt_item INTO gs_item.\n    WRITE: / gs_item-vbeln, gs_item-posnr, gs_item-matnr,\n             gs_item-arktx, gs_item-fkimg, gs_item-vrkme, gs_item-netwr.\n  ENDLOOP.\n\n* This classic list is a minimal draft. Consider ALV, paging or a\n* validated maximum date span for real-world data volumes.`;
