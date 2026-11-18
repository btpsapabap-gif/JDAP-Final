import { Router } from "express";
import { writeAuditEvent } from "../../audit/service.js";
import { evaluateAbapDraft, extractAbapSource } from "../../integrations/abap-static/draft-quality.js";
import { deriveSelectionTexts, selectionScreenDeclarations } from "../../integrations/abap-static/selection-texts.js";
import { listMockSystems } from "../../integrations/sap-mock.js";

function hasCleanCoreEvidenceNote(note = "") {
  return /\bATC\b|released\s+(?:SAP\s+)?API|release contract|extension[- ]point/i.test(String(note));
}

export function createApprovalRouter(pool) {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT r.id, r.artifact_id, r.status, r.request_note, r.review_note,
               r.requested_by, r.reviewed_by, r.created_at, r.reviewed_at,
               a.title AS artifact_title, a.artifact_type, a.content AS artifact_content,
               w.id AS workflow_id, w.prompt AS workflow_prompt
        FROM approval_requests r
        JOIN artifacts a ON a.id = r.artifact_id
        LEFT JOIN workflows w ON w.id = a.workflow_id
        ORDER BY CASE WHEN r.status='PENDING' THEN 0 ELSE 1 END, r.created_at DESC
        LIMIT 100
      `);
      res.json(result.rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.post("/", async (req, res) => {
    const { artifactId, requestNote = "" } = req.body || {};
    if (typeof artifactId !== "string") return res.status(400).json({ error: "A saved artifact ID is required." });
    if (typeof requestNote !== "string" || requestNote.length > 2000) return res.status(400).json({ error: "Review note must be text under 2,000 characters." });
    try {
      const artifact = await pool.query(`
        SELECT a.id, a.workflow_id, a.content, w.system_id, w.prompt
        FROM artifacts a LEFT JOIN workflows w ON w.id=a.workflow_id
        WHERE a.id=$1
      `, [artifactId]);
      if (!artifact.rowCount) return res.status(404).json({ error: "Saved draft not found." });
      if (/##\s+ABAP draft/i.test(artifact.rows[0].content)) {
        const source = extractAbapSource(artifact.rows[0].content);
        const system = listMockSystems().find(item => item.id === artifact.rows[0].system_id) || {};
        const qualityGate = evaluateAbapDraft(source, system, artifact.rows[0].prompt);
        if (qualityGate.blockers.length) {
          return res.status(422).json({
            state: "draft-quality-gate-blocked",
            qualityGate,
            error: `JDAP blocked approval because the ABAP draft has ${qualityGate.blockers.length} blocking quality finding(s). Correct the source and generate a new draft.`
          });
        }
      }
      const pending = await pool.query("SELECT id FROM approval_requests WHERE artifact_id=$1 AND status='PENDING' ORDER BY created_at DESC LIMIT 1", [artifactId]);
      if (pending.rowCount) return res.json({ id: pending.rows[0].id, status: "PENDING", existing: true });
      const created = await pool.query(
        "INSERT INTO approval_requests(artifact_id,request_note) VALUES($1,$2) RETURNING id,status,created_at",
        [artifactId, requestNote.trim()]
      );
      await writeAuditEvent(pool, artifact.rows[0].workflow_id, "APPROVAL_REQUESTED", { approvalId: created.rows[0].id, artifactId });
      res.status(201).json(created.rows[0]);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.post("/:id/prepare-selection-texts", async (req, res) => {
    const client = await pool.connect();
    try {
      const original = await client.query(`
        SELECT r.id AS approval_id, r.status, a.id AS artifact_id, a.workflow_id, a.title, a.artifact_type, a.content
        FROM approval_requests r JOIN artifacts a ON a.id=r.artifact_id
        WHERE r.id=$1
      `, [req.params.id]);
      if (!original.rowCount || original.rows[0].status !== "APPROVED") return res.status(409).json({ state: "draft-not-approved", message: "Choose a currently approved saved draft." });
      const row = original.rows[0];
      if (/## Selection screen texts\s/i.test(row.content)) return res.status(409).json({ state: "selection-texts-already-present", message: "This artifact already includes approved selection texts." });
      const source = extractAbapSource(row.content);
      const declarations = selectionScreenDeclarations(source);
      const entries = deriveSelectionTexts(source);
      if (!entries.length || entries.length !== declarations.length) {
        const tooLong = declarations.filter(item => item.name.length > 8).map(item => item.name);
        const unsupported = declarations.filter(item => item.name.length <= 8 && !entries.some(([name]) => name === item.name)).map(item => item.name);
        const reason = tooLong.length
          ? `Selection-screen names ${tooLong.join(", ")} exceed ABAP's eight-character limit. Generate a corrected report with short selection names, then request approval again.`
          : unsupported.length
          ? `JDAP could not safely label selection names ${unsupported.join(", ")}. Review and add explicit labels to a new draft before approval.`
          : "No PARAMETERS or SELECT-OPTIONS declarations were found.";
        return res.status(422).json({ state: "selection-texts-not-derivable", message: `${reason} No artifact was changed.` });
      }
      const section = `## Selection screen texts\n\n${entries.map(([name, text]) => `- ${name}: ${text}`).join("\n")}\n\n`;
      const content = row.content.replace(/(?=## ABAP draft\s+```abap)/i, section);
      await client.query("BEGIN");
      const artifact = await client.query(
        "INSERT INTO artifacts(workflow_id,title,artifact_type,content) VALUES($1,$2,$3,$4) RETURNING id",
        [row.workflow_id, `${row.title} — selection labels`, row.artifact_type, content]
      );
      const request = await client.query(
        "INSERT INTO approval_requests(artifact_id,request_note) VALUES($1,$2) RETURNING id,status,created_at",
        [artifact.rows[0].id, `Supplemental approval for selection-screen labels: ${entries.map(([name, text]) => `${name} = ${text}`).join("; ")}. The ABAP source is copied unchanged from approved artifact ${row.artifact_id}.`]
      );
      await client.query("COMMIT");
      await writeAuditEvent(pool, row.workflow_id, "SELECTION_TEXTS_REAPPROVAL_REQUESTED", { priorApprovalId: row.approval_id, priorArtifactId: row.artifact_id, artifactId: artifact.rows[0].id, approvalId: request.rows[0].id, selectionTextCount: entries.length });
      return res.status(201).json({ state: "pending-review", artifactId: artifact.rows[0].id, approvalId: request.rows[0].id, selectionTexts: entries.map(([name, text]) => ({ name, text })), message: "JDAP created a versioned draft with the same ABAP source and derived selection labels. The labels need a new approval before SAP writes are enabled." });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return res.status(500).json({ error: error.message });
    } finally { client.release(); }
  });

  router.patch("/:id", async (req, res) => {
    const { decision, reviewNote = "" } = req.body || {};
    if (!["APPROVED", "REJECTED"].includes(decision)) return res.status(400).json({ error: "Decision must be APPROVED or REJECTED." });
    if (typeof reviewNote !== "string" || reviewNote.length > 2000) return res.status(400).json({ error: "Review note must be text under 2,000 characters." });
    try {
      if (decision === "APPROVED") {
        const candidate = await pool.query(`
          SELECT a.content FROM approval_requests r JOIN artifacts a ON a.id=r.artifact_id
          WHERE r.id=$1 AND r.status='PENDING'
        `, [req.params.id]);
        if (!candidate.rowCount) return res.status(409).json({ error: "This request is missing or has already been reviewed." });
        if (/##\s+ABAP draft/i.test(candidate.rows[0].content) && !hasCleanCoreEvidenceNote(reviewNote)) {
          return res.status(422).json({ state: "clean-core-evidence-required", error: "For an ABAP approval, record the target SAP Clean Core ATC result, released API/release-contract evidence, or extension-point evidence in the reviewer note. JDAP cannot verify Clean Core compliance offline." });
        }
      }
      const updated = await pool.query(`
        UPDATE approval_requests SET status=$1, review_note=$2, reviewed_by='Local reviewer', reviewed_at=now()
        WHERE id=$3 AND status='PENDING'
        RETURNING id, artifact_id, status, review_note, reviewed_by, reviewed_at
      `, [decision, reviewNote.trim(), req.params.id]);
      if (!updated.rowCount) return res.status(409).json({ error: "This request is missing or has already been reviewed." });
      const workflow = await pool.query("SELECT workflow_id FROM artifacts WHERE id=$1", [updated.rows[0].artifact_id]);
      await writeAuditEvent(pool, workflow.rows[0]?.workflow_id || null, `APPROVAL_${decision}`, { approvalId: updated.rows[0].id, artifactId: updated.rows[0].artifact_id, reviewNote: reviewNote.trim() });
      res.json(updated.rows[0]);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.get("/:id/handoff", async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT r.id AS approval_id, r.status, r.request_note, r.review_note,
               r.requested_by, r.reviewed_by, r.created_at AS requested_at, r.reviewed_at,
               a.id AS artifact_id, a.title AS artifact_title, a.artifact_type,
               a.content AS artifact_content, a.created_at AS artifact_created_at,
               w.id AS workflow_id, w.prompt AS workflow_prompt, w.system_id
        FROM approval_requests r
        JOIN artifacts a ON a.id = r.artifact_id
        LEFT JOIN workflows w ON w.id = a.workflow_id
        WHERE r.id=$1
      `, [req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Approval record not found." });
      const row = result.rows[0];
      if (row.status !== "APPROVED") return res.status(409).json({ error: "Only approved drafts can be exported for handoff." });
      const source = extractAbapSource(row.artifact_content) || null;
      const handoff = {
        handoffType: "JDAP_APPROVED_DRAFT",
        generatedAt: new Date().toISOString(),
        sapDeployment: "NOT_PERFORMED",
        manualSapActionRequired: true,
        approval: {
          id: row.approval_id, status: row.status, requestedBy: row.requested_by,
          requestedAt: row.requested_at, requestNote: row.request_note,
          reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, reviewNote: row.review_note
        },
        workflow: { id: row.workflow_id, systemProfile: row.system_id, prompt: row.workflow_prompt },
        artifact: {
          id: row.artifact_id, title: row.artifact_title, type: row.artifact_type,
          createdAt: row.artifact_created_at, markdown: row.artifact_content, abapSource: source
        },
        limitations: [
          "This package is a developer handoff, not a SAP transport or repository object.",
          "JDAP did not create, activate, transport, or deploy anything in SAP.",
          "Run applicable SAP-side syntax, DDIC, ATC, authorization, and quality checks before use."
        ]
      };
      await writeAuditEvent(pool, row.workflow_id, "APPROVAL_HANDOFF_EXPORTED", { approvalId: row.approval_id, artifactId: row.artifact_id });
      res.setHeader("Content-Disposition", `attachment; filename="jdap-approved-handoff-${row.artifact_id.slice(0, 8)}.json"`);
      res.json(handoff);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  return router;
}
