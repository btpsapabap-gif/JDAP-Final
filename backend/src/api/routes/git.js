import { Router } from "express";
import { createHash } from "node:crypto";
import { readGitHubRepository, previewGitHubPullRequest, createGitHubDraftPullRequest } from "../../integrations/git/github.js";
import { extractAbapSource, evaluateAbapDraft } from "../../integrations/abap-static/draft-quality.js";
import { listMockSystems } from "../../integrations/sap-mock.js";
import { writeAuditEvent } from "../../audit/service.js";

function hasCleanCoreEvidenceNote(note = "") {
  return /\bATC\b|released\s+(?:SAP\s+)?API|release contract|extension[- ]point/i.test(String(note));
}

function draftQuery(pool, approvalId) {
  return pool.query(`
    SELECT r.id AS approval_id, r.status, r.review_note, a.id AS artifact_id,
           a.title AS artifact_title, a.content, w.id AS workflow_id,
           w.system_id, w.prompt
    FROM approval_requests r
    JOIN artifacts a ON a.id=r.artifact_id
    LEFT JOIN workflows w ON w.id=a.workflow_id
    WHERE r.id=$1 AND r.status='APPROVED'
  `, [approvalId]);
}

async function loadApprovedAbap(pool, approvalId) {
  if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.length > 80) return { error: { status: 400, state: "approval-required", message: "Choose an approved JDAP draft." } };
  const result = await draftQuery(pool, approvalId);
  if (!result.rowCount) return { error: { status: 409, state: "draft-not-approved", message: "The selected draft is not currently approved." } };
  const draft = result.rows[0];
  if (!hasCleanCoreEvidenceNote(draft.review_note)) return { error: { status: 422, state: "clean-core-evidence-required", message: "The ABAP approval has no recorded SAP Clean Core ATC, released API/release-contract, or extension-point evidence." } };
  const source = extractAbapSource(draft.content);
  if (!source) return { error: { status: 422, state: "abap-source-missing", message: "The approved artifact does not contain an ABAP report source." } };
  const system = listMockSystems().find(item => item.id === draft.system_id) || {};
  const qualityGate = evaluateAbapDraft(source, system, draft.prompt);
  if (qualityGate.blockers.length) return { error: { status: 422, state: "draft-quality-gate-blocked", message: "The approved ABAP source now has blocking JDAP quality findings; it cannot be sent to GitHub.", qualityGate } };
  const programName = source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z0-9_]+)/im)?.[1]?.toUpperCase() || "";
  if (!programName) return { error: { status: 422, state: "program-declaration-missing", message: "The approved ABAP source must declare a REPORT or PROGRAM before Git delivery." } };
  return { draft, source, programName };
}

function validateFileForProgram(filePath, programName) {
  const fileName = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
  if (fileName.toUpperCase() !== `${programName}.ABAP`) return "The destination file name must match the ABAP report name, for example " + programName + ".abap.";
  return "";
}

export function createGitRouter(pool) {
  const router = Router();
  router.post("/repository/read", async (req, res) => {
    const repositoryUrl = typeof req.body?.repositoryUrl === "string" ? req.body.repositoryUrl : "";
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const result = await readGitHubRepository({ repositoryUrl, token });
    res.status(result.status || (result.ok ? 200 : 502)).json(result);
  });
  router.get("/approved-drafts", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT r.id AS approval_id, a.title AS artifact_title, a.content, r.reviewed_at
        FROM approval_requests r JOIN artifacts a ON a.id=r.artifact_id
        WHERE r.status='APPROVED'
        ORDER BY r.reviewed_at DESC NULLS LAST, r.created_at DESC
        LIMIT 100
      `);
      const drafts = result.rows.flatMap(row => {
        const source = extractAbapSource(row.content);
        const programName = source?.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z0-9_]+)/im)?.[1]?.toUpperCase() || "";
        return source && programName ? [{ approvalId: row.approval_id, title: row.artifact_title, programName, reviewedAt: row.reviewed_at }] : [];
      });
      res.json({ drafts });
    } catch (error) { res.status(500).json({ state: "approved-drafts-unavailable", message: error.message }); }
  });
  router.post("/pull-requests/preview", async (req, res) => {
    try {
      const approved = await loadApprovedAbap(pool, req.body?.approvalId);
      if (approved.error) return res.status(approved.error.status).json(approved.error);
      const pathError = validateFileForProgram(req.body?.filePath, approved.programName);
      if (pathError) return res.status(400).json({ state: "invalid-file-path", message: pathError });
      const result = await previewGitHubPullRequest({ ...req.body, source: approved.source });
      if (!result.ok) return res.status(result.status || 502).json(result);
      res.json({ ...result, approvalId: approved.draft.approval_id, artifactTitle: approved.draft.artifact_title, programName: approved.programName });
    } catch (error) { res.status(500).json({ state: "pull-request-preview-failed", message: error.message }); }
  });
  router.post("/pull-requests/create", async (req, res) => {
    try {
      if (req.body?.confirmation !== "CREATE DRAFT PULL REQUEST") return res.status(400).json({ state: "confirmation-required", message: "Type CREATE DRAFT PULL REQUEST to confirm the GitHub write." });
      const approved = await loadApprovedAbap(pool, req.body?.approvalId);
      if (approved.error) return res.status(approved.error.status).json(approved.error);
      const pathError = validateFileForProgram(req.body?.filePath, approved.programName);
      if (pathError) return res.status(400).json({ state: "invalid-file-path", message: pathError });
      const result = await createGitHubDraftPullRequest({ ...req.body, source: approved.source });
      if (result.branchCreated || result.ok) {
        await writeAuditEvent(pool, approved.draft.workflow_id || null, result.ok ? "GITHUB_APPROVED_ABAP_DRAFT_PR_CREATED" : "GITHUB_APPROVED_ABAP_DRAFT_PR_PARTIAL", {
          approvalId: approved.draft.approval_id,
          artifactId: approved.draft.artifact_id,
          programName: approved.programName,
          repository: result.repository || String(req.body?.repositoryUrl || "").replace(/^https:\/\/github\.com\//i, ""),
          branchName: result.branchName || req.body?.branchName,
          filePath: req.body?.filePath,
          pullRequestUrl: result.pullRequestUrl || null,
          sourceSha256: createHash("sha256").update(approved.source).digest("hex"),
          state: result.state
        });
      }
      res.status(result.status || (result.ok ? 201 : 502)).json(result);
    } catch (error) { res.status(500).json({ state: "pull-request-create-failed", message: error.message }); }
  });
  return router;
}
