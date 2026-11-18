import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { activateAbapProgram, checkAbapProgramSyntax, checkSapAdtConnection, createInactiveAbapProgram, listSapTransportRequests, readAbapProgramSource, writeAbapSelectionTexts } from "../../integrations/sap-adt/client.js";
import { writeAuditEvent } from "../../audit/service.js";
import { evaluateAbapDraft, extractAbapSource } from "../../integrations/abap-static/draft-quality.js";
import { listMockSystems } from "../../integrations/sap-mock.js";

function validApiToken(req, envKey) {
  const supplied = req.get("authorization") || "";
  const match = /^Bearer (.+)$/i.exec(supplied);
  return validToken(match?.[1] || "", envKey);
}

function validToken(value, envKey) {
  const expected = process.env[envKey] || "";
  const supplied = String(value || "");
  if (!expected || !supplied) return false;
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function hasCleanCoreEvidenceNote(note = "") {
  return /\bATC\b|released\s+(?:SAP\s+)?API|release contract|extension[- ]point/i.test(String(note));
}

function withReportActivationNotRequested(message = "") {
  const text = String(message || "").trim();
  return /report activation was not requested\.?$/i.test(text)
    ? text
    : `${text}${text ? " " : ""}Report activation was not requested.`;
}

function comparableAbapSource(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // SAP may prepend editor/report banners. Ignore full-line comments and
    // formatting only; preserve all executable text and inline comments.
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("*") && !line.startsWith('"'))
    .join("\n");
}

function extractApprovedSelectionTexts(content = "") {
  const section = content.match(/## Selection screen texts\s*([\s\S]*?)(?=\n## |$)/i)?.[1] || "";
  return section.split(/\r?\n/).flatMap(line => {
    const match = /^\s*[-*]\s*([A-Z0-9_]{1,8})\s*:\s*(.{1,30})\s*$/.exec(line);
    return match ? [{ name: match[1].toUpperCase(), text: match[2].trim() }] : [];
  });
}

export function createSapAdtRouter(pool) {
  const router = Router();
  router.get("/connection", async (_req, res) => {
    try { res.json({ ...await checkSapAdtConnection(), sourceReadEnabled: process.env.SAP_ADT_ENABLE_SOURCE_READ === "true", objectCreateEnabled: process.env.SAP_ADT_ENABLE_OBJECT_CREATE === "true", objectActivationEnabled: process.env.SAP_ADT_ENABLE_OBJECT_ACTIVATION === "true" }); }
    catch (error) { res.status(400).json({ configured: true, state: "invalid-configuration", message: error.message }); }
  });
  router.get("/programs/:name/source", async (req, res) => {
    if (process.env.SAP_ADT_ENABLE_SOURCE_READ !== "true") return res.status(404).json({ state: "disabled", message: "SAP source retrieval is disabled." });
    if (!validApiToken(req, "SAP_ADT_READ_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid JDAP bearer token is required." });
    try {
      const result = await readAbapProgramSource(req.params.name);
      const status = result.status || 200;
      res.status(status).json(result);
    } catch (error) { res.status(400).json({ state: "invalid-configuration", message: error.message }); }
  });
  router.get("/transports", async (req, res) => {
    const bearer = /^Bearer (.+)$/i.exec(req.get("authorization") || "")?.[1] || "";
    if (!validApiToken(req, "SAP_ADT_READ_API_TOKEN") && !validToken(bearer, "SAP_ADT_ACTIVATE_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid JDAP read or delivery token is required." });
    try {
      const result = await listSapTransportRequests();
      res.status(result.status || (result.ok ? 200 : 502)).json(result);
    } catch (error) { res.status(400).json({ state: "invalid-configuration", message: error.message }); }
  });
  router.post("/programs/:name/syntax-check", async (req, res) => {
    if (process.env.SAP_ADT_ENABLE_SOURCE_READ !== "true") return res.status(404).json({ state: "disabled", message: "SAP-native syntax checks are disabled with source retrieval." });
    if (!validApiToken(req, "SAP_ADT_READ_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid JDAP read bearer token is required." });
    try {
      const requestedVersion = String(req.query.version || "active").toLowerCase();
      if (requestedVersion !== "active" && requestedVersion !== "inactive") return res.status(400).json({ state: "invalid-version", message: "Use version=active or version=inactive." });
      const result = await checkAbapProgramSyntax(req.params.name, process.env, fetch, requestedVersion);
      res.status(result.status || (result.ok ? 200 : 502)).json(result);
    } catch (error) { res.status(400).json({ state: "invalid-configuration", message: error.message }); }
  });
  router.post("/programs/create", async (req, res) => {
    if (process.env.SAP_ADT_ENABLE_OBJECT_CREATE !== "true") return res.status(404).json({ state: "disabled", message: "SAP object creation is disabled. No SAP request was sent." });
    const { approvalId, programName, description, confirmation } = req.body || {};
    const deliverApproved = req.body?.deliverApproved === true;
    const activateAfterCreate = deliverApproved || req.body?.activateAfterCreate === true;
    const activationConfirmation = req.body?.activationConfirmation || "";
    if (deliverApproved) {
      if (process.env.SAP_ADT_ENABLE_OBJECT_ACTIVATION !== "true") return res.status(404).json({ state: "activation-disabled", message: "Approved delivery requires SAP activation, but activation is disabled. No SAP request was sent." });
      if (!validToken(req.get("x-jdap-delivery-token"), "SAP_ADT_ACTIVATE_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid JDAP delivery token is required." });
    } else if (!validApiToken(req, "SAP_ADT_CREATE_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid, separate JDAP create token is required." });
    const packageName = String(req.body?.packageName || "$TMP").trim().toUpperCase();
    const transportRequest = String(req.body?.transportRequest || "").trim().toUpperCase();
    if ((packageName === "$TMP") !== !transportRequest) return res.status(400).json({ state: "package-transport-mismatch", message: "Choose either local $TMP with no transport, or a transportable package and one modifiable Workbench request." });
    if (transportRequest) {
      try {
        const listing = await listSapTransportRequests();
        if (!listing.ok) return res.status(listing.status || 502).json({ state: "transport-preflight-failed", message: `JDAP could not verify the selected transport request. ${listing.message}` });
        const selected = listing.requests.find(item => item.id.toUpperCase() === transportRequest);
        const modifiable = selected && /^(?:D|MODIFIABLE)$/i.test(selected.status) && /^(?:K|WORKBENCH)$/i.test(selected.type);
        if (!modifiable) return res.status(409).json({ state: "transport-request-not-modifiable-workbench", message: "The selected SAP request is not currently listed as a modifiable Workbench request for this ADT user. Refresh the list and choose a modifiable Workbench request." });
      } catch (error) { return res.status(400).json({ state: "transport-preflight-failed", message: error.message }); }
    }
    if (deliverApproved) {
      if (confirmation !== "DELIVER APPROVED REPORT") return res.status(400).json({ state: "confirmation-required", message: "Type DELIVER APPROVED REPORT to create or finalize this approved SAP report, activate its source, and save and activate its selection labels." });
    } else {
      if (confirmation !== "CREATE IN SAP") return res.status(400).json({ state: "confirmation-required", message: "Type CREATE IN SAP to confirm this one-time object creation." });
      if (activateAfterCreate && process.env.SAP_ADT_ENABLE_OBJECT_ACTIVATION !== "true") return res.status(404).json({ state: "activation-disabled", message: "SAP activation is disabled. The create request was not sent." });
      if (activateAfterCreate && activationConfirmation !== "ACTIVATE IN SAP") return res.status(400).json({ state: "activation-confirmation-required", message: "Type ACTIVATE IN SAP to enable activation for this approved draft." });
      if (activateAfterCreate && !validToken(req.get("x-jdap-activation-token"), "SAP_ADT_ACTIVATE_API_TOKEN")) return res.status(401).json({ state: "activation-unauthorized", message: "A valid, separate JDAP activation token is required." });
    }
    if (typeof approvalId !== "string" || approvalId.length > 80) return res.status(400).json({ state: "approval-required", message: "Choose an approved saved JDAP draft." });
    try {
      const approved = await pool.query(`
        SELECT r.id AS approval_id, r.status, r.review_note, a.content, w.id AS workflow_id, w.system_id, w.prompt
        FROM approval_requests r
        JOIN artifacts a ON a.id=r.artifact_id
        LEFT JOIN workflows w ON w.id=a.workflow_id
        WHERE r.id=$1 AND r.status='APPROVED'
      `, [approvalId]);
      if (!approved.rowCount) return res.status(409).json({ state: "draft-not-approved", message: "Only a draft with an APPROVED review record can be sent to SAP." });
      if (!hasCleanCoreEvidenceNote(approved.rows[0].review_note)) return res.status(422).json({ state: "clean-core-evidence-required", message: "SAP write blocked: the approval has no recorded SAP Clean Core ATC, released API/release-contract, or extension-point evidence. Add the evidence to the reviewer note and obtain approval before retrying." });
      const source = extractAbapSource(approved.rows[0].content);
      if (!source) return res.status(422).json({ state: "abap-source-missing", message: "The approved artifact has no extractable ABAP draft." });
      const targetSystem = listMockSystems().find(item => item.id === approved.rows[0].system_id) || {};
      const qualityGate = evaluateAbapDraft(source, targetSystem, approved.rows[0].prompt);
      if (qualityGate.blockers.length) return res.status(422).json({ state: "draft-quality-gate-blocked", qualityGate, message: "JDAP blocked the SAP request because the approved source has blocking offline quality findings. Correct the draft, request approval for a new version, and retry." });
      const selectionTexts = extractApprovedSelectionTexts(approved.rows[0].content);
      if (/\b(?:SELECT-OPTIONS|PARAMETERS)\b/i.test(source) && !selectionTexts.length) return res.status(422).json({ state: "selection-texts-missing", message: "This approved draft predates JDAP selection-label support. Generate a fresh workflow draft and request approval again; the approved artifact cannot be changed after approval." });
      let result = await createInactiveAbapProgram({ approvalId, programName, description, source, packageName, transportRequest });
      let sourceAlreadyActive = false;
      if (deliverApproved && !result.ok && ["program-already-exists", "transport-create-requires-new-object"].includes(result.state)) {
        const [activeSource, inactiveSource] = await Promise.all([
          readAbapProgramSource(String(programName || "").trim().toUpperCase(), process.env, fetch, "active"),
          readAbapProgramSource(String(programName || "").trim().toUpperCase(), process.env, fetch, "inactive")
        ]);
        const activeMatches = activeSource.ok && comparableAbapSource(activeSource.source) === comparableAbapSource(source);
        const inactiveMatches = inactiveSource.ok && comparableAbapSource(inactiveSource.source) === comparableAbapSource(source);
        if (!activeMatches && !inactiveMatches) return res.status(409).json({ state: "existing-program-differs", message: `SAP program ${String(programName || "").trim().toUpperCase()} already exists, but neither its active nor inactive source matches the approved draft. JDAP did not change or reassign it.` });
        sourceAlreadyActive = activeMatches && !inactiveMatches;
        result = { ok: true, status: 200, state: sourceAlreadyActive ? "existing-approved-source-active" : "existing-approved-source-inactive", created: false, activated: sourceAlreadyActive, programName: String(programName || "").trim().toUpperCase(), package: packageName, transportRequest: transportRequest || null, message: sourceAlreadyActive ? "The existing active SAP source matches the approved draft. JDAP will verify syntax and complete the approved labels." : "The existing inactive SAP source matches the approved draft. JDAP will activate it and complete the approved labels; the existing object will not be moved or reassigned." };
      }
      if (deliverApproved && result.ok) {
        const version = sourceAlreadyActive ? "active" : "inactive";
        const syntaxCheck = await checkAbapProgramSyntax(result.programName, process.env, fetch, version);
        result.sapSyntaxCheck = syntaxCheck;
        if (!syntaxCheck.ok || syntaxCheck.state !== "sap-syntax-ok") {
          result.ok = false;
          result.status = syntaxCheck.status || 502;
          result.state = sourceAlreadyActive ? "existing-active-syntax-check-failed" : "saved-inactive-syntax-check-failed";
          result.message = sourceAlreadyActive
            ? `The approved SAP source is already active, but its native syntax check could not be confirmed. Selection texts were not changed. ${syntaxCheck.message}`
            : `The approved source is saved inactive, but its native syntax check could not be confirmed. JDAP stopped before report activation or selection-text changes. ${syntaxCheck.message}`;
        } else {
          if (!sourceAlreadyActive) {
            const activation = await activateAbapProgram({ programName: result.programName, source });
            result.activation = activation;
            if (!activation.ok) {
              result.ok = false;
              result.status = activation.status || 502;
              result.state = "saved-inactive-activation-failed";
              result.activated = false;
              result.message = `The approved source is saved, but SAP report activation did not complete. JDAP stopped before selection-text changes. ${activation.message}`;
            } else {
              result.activated = true;
              if (result.created) result.message = `The new approved report source was saved inactive in package ${packageName}.`;
              result.message = `${result.message} ${activation.message}`;
            }
          }
          if (result.ok && selectionTexts.length) {
            const labelsResult = await writeAbapSelectionTexts({ programName: result.programName, entries: selectionTexts, activate: true, transportRequest });
            result.selectionTexts = labelsResult;
            result.selectionTextsPending = !labelsResult.ok;
            if (!labelsResult.ok) {
              result.ok = false;
              result.status = labelsResult.status || 502;
              result.state = "report-active-selection-texts-failed";
              result.activated = true;
              result.message = `The approved report source is active, but SAP did not save, activate, and verify its approved selection labels. The report remains active with labels pending. ${labelsResult.message}`;
            } else {
              result.state = "delivered-and-verified";
              result.message = `${result.message} ${labelsResult.message} ${result.created ? `The new object and text-pool changes used package ${packageName}${transportRequest ? ` and request ${transportRequest}` : " ($TMP, local only)"}.` : "The existing object's package and transport assignment were left unchanged."}`;
            }
          } else if (result.ok) {
            result.state = "delivered-and-verified";
            result.message = `${result.message} The approved report is active; no selection texts were defined in the approved artifact.`;
          }
        }
        if (result.created || result.activated) await writeAuditEvent(pool, approved.rows[0].workflow_id || null, result.ok ? "SAP_ADT_APPROVED_REPORT_DELIVERED" : "SAP_ADT_APPROVED_REPORT_DELIVERY_PARTIAL", { approvalId, programName: result.programName, package: result.package || packageName, transportRequest: result.transportRequest || null, sourceSha256: createHash("sha256").update(source).digest("hex"), state: result.state, activated: result.activated === true, selectionTextCount: selectionTexts.length, sapSyntaxCheckState: result.sapSyntaxCheck?.state || null });
        return res.status(result.status || (result.ok ? 201 : 502)).json(result);
      }
      if (result.ok && activateAfterCreate) {
        const syntaxCheck = await checkAbapProgramSyntax(result.programName, process.env, fetch, "inactive");
        result.sapSyntaxCheck = syntaxCheck;
        if (!syntaxCheck.ok || syntaxCheck.state !== "sap-syntax-ok") {
          result.ok = false;
          result.created = true;
          result.status = syntaxCheck.status || 502;
          result.activated = false;
          result.state = "saved-inactive-sap-syntax-check-failed";
          result.message = syntaxCheck.state === "sap-syntax-errors"
            ? `The approved report was saved inactive, but SAP's native syntax check found errors. JDAP did not request report activation. ${syntaxCheck.message}`
            : `The approved report was saved inactive, but JDAP could not confirm a clean SAP syntax check. JDAP did not request report activation. ${syntaxCheck.message}`;
        } else {
          const activation = await activateAbapProgram({ programName: result.programName, source });
          result.activation = activation;
          result.activated = activation.ok;
          result.ok = activation.ok;
          result.state = activation.ok ? "activated" : "saved-inactive-activation-failed";
          if (!activation.ok) result.status = activation.status || 502;
          result.message = activation.ok
            ? `${result.message} ${syntaxCheck.message} ${activation.message}`
            : `SAP's native syntax check passed, but report activation did not complete: ${activation.message}`;
        }
      }
      if (result.ok && activateAfterCreate && selectionTexts.length) {
        // SAP needs the report's first activation before its text pool can be
        // saved and activated. Keep report activation and text-pool activation
        // separate in the result so a failed label write is not misreported.
        const labelsResult = await writeAbapSelectionTexts({ programName: result.programName, entries: selectionTexts, activate: true, transportRequest });
        result.selectionTexts = labelsResult;
        result.selectionTextsPending = !labelsResult.ok;
        if (!labelsResult.ok) {
          result.ok = false;
          result.created = true;
          result.status = labelsResult.status || 502;
          result.state = "report-activated-selection-texts-failed";
          result.activated = true;
          result.message = `The approved report source is active, but SAP did not save, activate, and verify its approved selection labels. The report remains active with labels pending. ${labelsResult.message}`;
        } else {
          result.message = `${result.message} ${labelsResult.message}`;
        }
      } else if (result.ok && !activateAfterCreate && selectionTexts.length) {
        result.selectionTextsPending = true;
        result.message = `${result.message} Approved selection labels remain pending because SAP requires the report to be active first. Use “Activate this approved report”; JDAP will activate the approved source, then save and activate its labels.`;
      }
      if (result.ok || result.created) {
        await writeAuditEvent(pool, approved.rows[0].workflow_id || null, result.ok ? (result.activated ? "SAP_ADT_PROGRAM_CREATED_AND_ACTIVATED" : result.recoveredBlankShell ? "SAP_ADT_PROGRAM_RECOVERED_INACTIVE" : "SAP_ADT_PROGRAM_CREATED_INACTIVE") : "SAP_ADT_PROGRAM_CREATE_PARTIAL", {
          approvalId, programName: result.programName || String(programName || "").toUpperCase(), package: result.package || packageName, transportRequest: result.transportRequest || null,
          sourceSha256: createHash("sha256").update(source).digest("hex"), state: result.state, recoveredBlankShell: result.recoveredBlankShell || false, activated: result.activated === true, selectionTextCount: selectionTexts.length, sapSyntaxCheckState: result.sapSyntaxCheck?.state || null
        });
      }
      res.status(result.status || (result.ok ? 201 : 502)).json(result);
    } catch (error) { res.status(400).json({ state: "invalid-configuration", message: error.message }); }
  });

  // Recovery path for approved labels on a report that is already active.
  // It can activate the text pool, but never activates the report source.
  router.post("/programs/selection-texts", async (req, res) => {
    if (process.env.SAP_ADT_ENABLE_OBJECT_CREATE !== "true") return res.status(404).json({ state: "disabled", message: "SAP selection-text updates are disabled. No SAP request was sent." });
    if (!validApiToken(req, "SAP_ADT_CREATE_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid JDAP create token is required." });
    const { approvalId, programName, confirmation } = req.body || {};
    const transportRequest = String(req.body?.transportRequest || "").trim().toUpperCase();
    const normalizedName = String(programName || "").trim().toUpperCase();
    if (confirmation !== "SAVE SELECTION TEXTS") return res.status(400).json({ state: "confirmation-required", message: "Type SAVE SELECTION TEXTS to confirm this labels-only update." });
    if (typeof approvalId !== "string" || approvalId.length > 80) return res.status(400).json({ state: "approval-required", message: "Choose an approved saved JDAP draft." });
    if (!/^Z[A-Z0-9_]{1,39}$/.test(normalizedName)) return res.status(400).json({ state: "invalid-program-name", message: "Selection-text updates are limited to a Z program name." });
    try {
      const approved = await pool.query(`
        SELECT r.id AS approval_id, r.status, r.review_note, a.content, w.id AS workflow_id, w.system_id, w.prompt
        FROM approval_requests r JOIN artifacts a ON a.id=r.artifact_id
        LEFT JOIN workflows w ON w.id=a.workflow_id
        WHERE r.id=$1 AND r.status='APPROVED'
      `, [approvalId]);
      if (!approved.rowCount) return res.status(409).json({ state: "draft-not-approved", message: "Only an approved saved draft can be sent to SAP." });
      if (!hasCleanCoreEvidenceNote(approved.rows[0].review_note)) return res.status(422).json({ state: "clean-core-evidence-required", message: "SAP update blocked: the approval has no recorded SAP Clean Core ATC, released API/release-contract, or extension-point evidence." });
      const source = extractAbapSource(approved.rows[0].content);
      const declaration = source?.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z0-9_]+)/im)?.[1]?.toUpperCase();
      if (declaration !== normalizedName) return res.status(409).json({ state: "program-name-mismatch", message: "Program name must match the declaration in the approved source." });
      const selectionTexts = extractApprovedSelectionTexts(approved.rows[0].content);
      if (!selectionTexts.length) return res.status(422).json({ state: "selection-texts-missing", message: "The approved draft contains no approved selection labels to save." });
      const targetSystem = listMockSystems().find(item => item.id === approved.rows[0].system_id) || {};
      const qualityGate = evaluateAbapDraft(source, targetSystem, approved.rows[0].prompt);
      if (qualityGate.blockers.length) return res.status(422).json({ state: "draft-quality-gate-blocked", qualityGate, message: "JDAP blocked the SAP request because the approved source has blocking offline quality findings." });
      if (transportRequest) {
        const listing = await listSapTransportRequests();
        if (!listing.ok) return res.status(listing.status || 502).json({ state: "transport-preflight-failed", message: `JDAP could not verify the selected transport request. ${listing.message}` });
        const selected = listing.requests.find(item => item.id.toUpperCase() === transportRequest);
        if (!selected || !/^(?:D|MODIFIABLE)$/i.test(selected.status) || !/^(?:K|WORKBENCH)$/i.test(selected.type)) return res.status(409).json({ state: "transport-request-not-modifiable-workbench", message: "Choose a modifiable Workbench request for this SAP object." });
      }
      const live = await readAbapProgramSource(normalizedName, process.env, fetch, "active");
      if (!live.ok) return res.status(409).json({ state: "report-must-be-active", message: "Activate the approved report source first. SAP does not save and activate its selection-text pool while the report is still inactive; no selection-text write was sent." });
      if (comparableAbapSource(live.source) !== comparableAbapSource(source)) return res.status(409).json({ state: "sap-source-differs", message: "Active SAP source differs from the approved JDAP draft. Selection labels were not changed." });
      const labelsResult = await writeAbapSelectionTexts({ programName: normalizedName, entries: selectionTexts, activate: true, transportRequest });
      if (!labelsResult.ok) return res.status(labelsResult.status || 502).json({ ...labelsResult, message: withReportActivationNotRequested(labelsResult.message) });
      await writeAuditEvent(pool, approved.rows[0].workflow_id || null, "SAP_ADT_SELECTION_TEXTS_ACTIVATED", { approvalId, programName: normalizedName, selectionTextCount: selectionTexts.length, transportRequest: transportRequest || null, state: labelsResult.state });
      return res.status(200).json({ ...labelsResult, reportActivationRequested: false, message: withReportActivationNotRequested(labelsResult.message) });
    } catch (error) { return res.status(400).json({ state: "selection-text-save-failed", message: error.message }); }
  });

  router.post("/programs/activate", async (req, res) => {
    if (process.env.SAP_ADT_ENABLE_OBJECT_ACTIVATION !== "true") return res.status(404).json({ state: "disabled", message: "SAP object activation is disabled. No SAP request was sent." });
    if (!validToken(req.get("x-jdap-activation-token"), "SAP_ADT_ACTIVATE_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid, separate JDAP activation token is required." });
    const { approvalId, programName, confirmation } = req.body || {};
    const transportRequest = String(req.body?.transportRequest || "").trim().toUpperCase();
    if (confirmation !== "ACTIVATE IN SAP") return res.status(400).json({ state: "confirmation-required", message: "Type ACTIVATE IN SAP to confirm activation of this approved draft." });
    if (typeof approvalId !== "string" || approvalId.length > 80) return res.status(400).json({ state: "approval-required", message: "Choose an approved saved JDAP draft." });
    try {
      const approved = await pool.query(`
        SELECT r.id AS approval_id, r.status, r.review_note, a.content, w.id AS workflow_id, w.system_id, w.prompt
        FROM approval_requests r JOIN artifacts a ON a.id=r.artifact_id
        LEFT JOIN workflows w ON w.id=a.workflow_id
        WHERE r.id=$1 AND r.status='APPROVED'
      `, [approvalId]);
      if (!approved.rowCount) return res.status(409).json({ state: "draft-not-approved", message: "Only an approved saved draft can be activated." });
      if (transportRequest) {
        const listing = await listSapTransportRequests();
        if (!listing.ok) return res.status(listing.status || 502).json({ state: "transport-preflight-failed", message: `JDAP could not verify the selected transport request. ${listing.message}` });
        const selected = listing.requests.find(item => item.id.toUpperCase() === transportRequest);
        if (!selected || !/^(?:D|MODIFIABLE)$/i.test(selected.status) || !/^(?:K|WORKBENCH)$/i.test(selected.type)) return res.status(409).json({ state: "transport-request-not-modifiable-workbench", message: "The selected SAP request is not currently listed as a modifiable Workbench request for this ADT user. Refresh the list and choose a modifiable Workbench request." });
      }
      if (!hasCleanCoreEvidenceNote(approved.rows[0].review_note)) return res.status(422).json({ state: "clean-core-evidence-required", message: "SAP activation blocked: the approval has no recorded SAP Clean Core ATC, released API/release-contract, or extension-point evidence. Add the evidence to the reviewer note and obtain approval before retrying." });
      const source = extractAbapSource(approved.rows[0].content);
      if (!source) return res.status(422).json({ state: "abap-source-missing", message: "The approved artifact has no extractable ABAP source." });
      const targetSystem = listMockSystems().find(item => item.id === approved.rows[0].system_id) || {};
      const qualityGate = evaluateAbapDraft(source, targetSystem, approved.rows[0].prompt);
      if (qualityGate.blockers.length) return res.status(422).json({ state: "draft-quality-gate-blocked", qualityGate, message: "JDAP blocked activation because the approved source has blocking offline quality findings. Correct the draft and obtain approval for a new version first." });
      const selectionTexts = extractApprovedSelectionTexts(approved.rows[0].content);
      if (/\b(?:SELECT-OPTIONS|PARAMETERS)\b/i.test(source) && !selectionTexts.length) return res.status(422).json({ state: "selection-texts-missing", message: "This approved draft predates JDAP selection-label support. Generate a fresh workflow draft and request approval again; the approved artifact cannot be changed after approval." });
      const normalizedName = String(programName || "").trim().toUpperCase();
      const declaration = source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z0-9_]+)/im)?.[1]?.toUpperCase();
      if (declaration !== normalizedName) return res.status(409).json({ state: "program-name-mismatch", message: "Program name must match the declaration in the approved source." });
      const live = await readAbapProgramSource(normalizedName);
      if (!live.ok) return res.status(live.status || 502).json(live);
      if (comparableAbapSource(live.source) !== comparableAbapSource(source)) return res.status(409).json({ state: "sap-source-differs", message: "SAP executable source differs from the approved JDAP draft after ignoring blank lines, indentation, and full-line comments. Activation was not requested." });
      const syntaxCheck = await checkAbapProgramSyntax(normalizedName, process.env, fetch, "inactive");
      if (!syntaxCheck.ok || syntaxCheck.state !== "sap-syntax-ok") {
        const isSyntaxError = syntaxCheck.state === "sap-syntax-errors";
        return res.status(syntaxCheck.status || 502).json({ state: isSyntaxError ? "sap-syntax-errors" : "sap-syntax-check-unconfirmed", syntaxCheck, message: isSyntaxError ? `SAP's native syntax check found errors in the inactive source for ${normalizedName}. Report activation was not requested.` : `JDAP could not confirm a clean SAP syntax check for the inactive source of ${normalizedName}. Report activation was not requested. ${syntaxCheck.message}` });
      }
      const result = await activateAbapProgram({ programName: normalizedName, source });
      result.syntaxCheck = syntaxCheck;
      result.message = result.ok ? `${syntaxCheck.message} ${result.message}` : result.message;
      if (result.ok) {
        await writeAuditEvent(pool, approved.rows[0].workflow_id || null, "SAP_ADT_PROGRAM_ACTIVATED", { approvalId, programName: normalizedName, sourceSha256: createHash("sha256").update(source).digest("hex"), state: result.state });
        if (selectionTexts.length) {
          const labelsResult = await writeAbapSelectionTexts({ programName: normalizedName, entries: selectionTexts, activate: true, transportRequest });
          result.selectionTexts = labelsResult;
          result.selectionTextsPending = !labelsResult.ok;
          if (!labelsResult.ok) {
            result.ok = false;
            result.status = labelsResult.status || 502;
            result.state = "report-activated-selection-texts-failed";
            result.activated = true;
            result.message = `The approved report source is active, but SAP did not save, activate, and verify its approved selection labels. The report remains active with labels pending. ${labelsResult.message}`;
          } else {
            await writeAuditEvent(pool, approved.rows[0].workflow_id || null, "SAP_ADT_SELECTION_TEXTS_ACTIVATED", { approvalId, programName: normalizedName, selectionTextCount: selectionTexts.length, transportRequest: transportRequest || null, state: labelsResult.state });
            result.message = `${result.message} ${labelsResult.message}`;
          }
        }
      }
      return res.status(result.status || (result.ok ? 200 : 502)).json(result);
    } catch (error) { return res.status(400).json({ state: "invalid-configuration", message: error.message }); }
  });
  return router;
}
