import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { activateAbapProgram, checkAbapProgramSyntax, checkSapAdtConnection, createInactiveAbapProgram, readAbapProgramSource, writeAbapSelectionTexts } from "../../integrations/sap-adt/client.js";
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
    if (!validApiToken(req, "SAP_ADT_CREATE_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid, separate JDAP create token is required." });
    const { approvalId, programName, description, confirmation, activateAfterCreate, activationConfirmation } = req.body || {};
    if (confirmation !== "CREATE IN SAP") return res.status(400).json({ state: "confirmation-required", message: "Type CREATE IN SAP to confirm this one-time object creation." });
    if (activateAfterCreate && process.env.SAP_ADT_ENABLE_OBJECT_ACTIVATION !== "true") return res.status(404).json({ state: "activation-disabled", message: "SAP activation is disabled. The create request was not sent." });
    if (activateAfterCreate && activationConfirmation !== "ACTIVATE IN SAP") return res.status(400).json({ state: "activation-confirmation-required", message: "Type ACTIVATE IN SAP to enable activation for this approved draft." });
    if (activateAfterCreate && !validToken(req.get("x-jdap-activation-token"), "SAP_ADT_ACTIVATE_API_TOKEN")) return res.status(401).json({ state: "activation-unauthorized", message: "A valid, separate JDAP activation token is required." });
    if (typeof approvalId !== "string" || approvalId.length > 80) return res.status(400).json({ state: "approval-required", message: "Choose an approved saved JDAP draft." });
    try {
      const approved = await pool.query(`
        SELECT r.id AS approval_id, r.status, r.review_note, a.content, w.id AS workflow_id, w.system_id
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
      const qualityGate = evaluateAbapDraft(source, targetSystem);
      if (qualityGate.blockers.length) return res.status(422).json({ state: "draft-quality-gate-blocked", qualityGate, message: "JDAP blocked the SAP request because the approved source has blocking offline quality findings. Correct the draft, request approval for a new version, and retry." });
      const selectionTexts = extractApprovedSelectionTexts(approved.rows[0].content);
      if (/\b(?:SELECT-OPTIONS|PARAMETERS)\b/i.test(source) && !selectionTexts.length) return res.status(422).json({ state: "selection-texts-missing", message: "This approved draft predates JDAP selection-label support. Generate a fresh workflow draft and request approval again; the approved artifact cannot be changed after approval." });
      const result = await createInactiveAbapProgram({ approvalId, programName, description, source });
      if (result.ok && selectionTexts.length) {
        const labelsResult = await writeAbapSelectionTexts({ programName: result.programName, entries: selectionTexts, activate: activateAfterCreate });
        result.selectionTexts = labelsResult;
        if (!labelsResult.ok) {
          result.ok = false;
          result.created = true;
          result.status = labelsResult.status || 502;
          result.state = "saved-inactive-selection-texts-failed";
          result.activated = false;
          result.message = `The approved source was saved, but JDAP could not save, activate, and verify its selection labels. The report was not activated. ${labelsResult.message}`;
        }
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
      if (result.ok || result.created) {
        await writeAuditEvent(pool, approved.rows[0].workflow_id || null, result.ok ? (result.activated ? "SAP_ADT_PROGRAM_CREATED_AND_ACTIVATED" : result.recoveredBlankShell ? "SAP_ADT_PROGRAM_RECOVERED_INACTIVE" : "SAP_ADT_PROGRAM_CREATED_INACTIVE") : "SAP_ADT_PROGRAM_CREATE_PARTIAL", {
          approvalId, programName: result.programName || String(programName || "").toUpperCase(), package: "$TMP",
          sourceSha256: createHash("sha256").update(source).digest("hex"), state: result.state, recoveredBlankShell: result.recoveredBlankShell || false, activated: result.activated === true, selectionTextCount: selectionTexts.length, sapSyntaxCheckState: result.sapSyntaxCheck?.state || null
        });
      }
      res.status(result.status || (result.ok ? 201 : 502)).json(result);
    } catch (error) { res.status(400).json({ state: "invalid-configuration", message: error.message }); }
  });

  router.post("/programs/activate", async (req, res) => {
    if (process.env.SAP_ADT_ENABLE_OBJECT_ACTIVATION !== "true") return res.status(404).json({ state: "disabled", message: "SAP object activation is disabled. No SAP request was sent." });
    if (!validToken(req.get("x-jdap-activation-token"), "SAP_ADT_ACTIVATE_API_TOKEN")) return res.status(401).json({ state: "unauthorized", message: "A valid, separate JDAP activation token is required." });
    const { approvalId, programName, confirmation } = req.body || {};
    if (confirmation !== "ACTIVATE IN SAP") return res.status(400).json({ state: "confirmation-required", message: "Type ACTIVATE IN SAP to confirm activation of this approved draft." });
    if (typeof approvalId !== "string" || approvalId.length > 80) return res.status(400).json({ state: "approval-required", message: "Choose an approved saved JDAP draft." });
    try {
      const approved = await pool.query(`
        SELECT r.id AS approval_id, r.status, r.review_note, a.content, w.id AS workflow_id, w.system_id
        FROM approval_requests r JOIN artifacts a ON a.id=r.artifact_id
        LEFT JOIN workflows w ON w.id=a.workflow_id
        WHERE r.id=$1 AND r.status='APPROVED'
      `, [approvalId]);
      if (!approved.rowCount) return res.status(409).json({ state: "draft-not-approved", message: "Only an approved saved draft can be activated." });
      if (!hasCleanCoreEvidenceNote(approved.rows[0].review_note)) return res.status(422).json({ state: "clean-core-evidence-required", message: "SAP activation blocked: the approval has no recorded SAP Clean Core ATC, released API/release-contract, or extension-point evidence. Add the evidence to the reviewer note and obtain approval before retrying." });
      const source = extractAbapSource(approved.rows[0].content);
      if (!source) return res.status(422).json({ state: "abap-source-missing", message: "The approved artifact has no extractable ABAP source." });
      const targetSystem = listMockSystems().find(item => item.id === approved.rows[0].system_id) || {};
      const qualityGate = evaluateAbapDraft(source, targetSystem);
      if (qualityGate.blockers.length) return res.status(422).json({ state: "draft-quality-gate-blocked", qualityGate, message: "JDAP blocked activation because the approved source has blocking offline quality findings. Correct the draft and obtain approval for a new version first." });
      const selectionTexts = extractApprovedSelectionTexts(approved.rows[0].content);
      if (/\b(?:SELECT-OPTIONS|PARAMETERS)\b/i.test(source) && !selectionTexts.length) return res.status(422).json({ state: "selection-texts-missing", message: "This approved draft predates JDAP selection-label support. Generate a fresh workflow draft and request approval again; the approved artifact cannot be changed after approval." });
      const normalizedName = String(programName || "").trim().toUpperCase();
      const declaration = source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z0-9_]+)/im)?.[1]?.toUpperCase();
      if (declaration !== normalizedName) return res.status(409).json({ state: "program-name-mismatch", message: "Program name must match the declaration in the approved source." });
      const live = await readAbapProgramSource(normalizedName);
      if (!live.ok) return res.status(live.status || 502).json(live);
      if (comparableAbapSource(live.source) !== comparableAbapSource(source)) return res.status(409).json({ state: "sap-source-differs", message: "SAP executable source differs from the approved JDAP draft after ignoring blank lines, indentation, and full-line comments. Activation was not requested." });
      if (selectionTexts.length) {
        const labelsResult = await writeAbapSelectionTexts({ programName: normalizedName, entries: selectionTexts, activate: true });
        if (!labelsResult.ok) return res.status(labelsResult.status || 502).json({ ...labelsResult, message: `${labelsResult.message} Report activation was not requested.` });
      }
      const syntaxCheck = await checkAbapProgramSyntax(normalizedName);
      if (!syntaxCheck.ok || syntaxCheck.state !== "sap-syntax-ok") {
        const isSyntaxError = syntaxCheck.state === "sap-syntax-errors";
        return res.status(syntaxCheck.status || 502).json({ state: isSyntaxError ? "sap-syntax-errors" : "sap-syntax-check-unconfirmed", syntaxCheck, message: isSyntaxError ? `SAP's native syntax check found errors in ${normalizedName}. Report activation was not requested.` : `JDAP could not confirm a clean SAP syntax check for ${normalizedName}. Report activation was not requested. ${syntaxCheck.message}` });
      }
      const result = await activateAbapProgram({ programName: normalizedName, source });
      result.syntaxCheck = syntaxCheck;
      result.message = result.ok ? `${syntaxCheck.message} ${result.message}` : result.message;
      if (result.ok) await writeAuditEvent(pool, approved.rows[0].workflow_id || null, "SAP_ADT_PROGRAM_ACTIVATED", { approvalId, programName: normalizedName, sourceSha256: createHash("sha256").update(source).digest("hex"), state: result.state });
      return res.status(result.status || (result.ok ? 200 : 502)).json(result);
    } catch (error) { return res.status(400).json({ state: "invalid-configuration", message: error.message }); }
  });
  return router;
}
