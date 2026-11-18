import { Router } from "express";
import { evaluateAbapDraft, renderDraftQualitySections } from "../../integrations/abap-static/draft-quality.js";
import { listMockSystems } from "../../integrations/sap-mock.js";

const MAX_SOURCE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeDraft(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  if (typeof body.source !== "string" || !body.source.trim()) {
    return { error: "ABAP source is required." };
  }
  if (Buffer.byteLength(body.source, "utf8") > MAX_SOURCE_BYTES) {
    return { error: "ABAP source must be smaller than 1 MB." };
  }
  const declaredName = body.source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z][A-Z0-9_]*)/im)?.[1]?.toUpperCase() || "JDAP_DRAFT";
  const title = String(body.title || `${declaredName}.abap`).trim().slice(0, 120) || `${declaredName}.abap`;
  return { title, programName: declaredName, source: body.source };
}

async function saveAudit(client, id, programName, action) {
  await client.query(
    "INSERT INTO audit_logs(workflow_id,event,details) VALUES(NULL,$1,$2::jsonb)",
    [action, JSON.stringify({ draftId: id, programName })]
  );
}

export function createCodeStudioRouter(pool) {
  const router = Router();

  router.get("/drafts", async (_req, res) => {
    try {
      const result = await pool.query("SELECT id,title,program_name,created_at,updated_at FROM code_studio_drafts ORDER BY updated_at DESC LIMIT 100");
      res.json(result.rows);
    } catch {
      res.status(500).json({ error: "Could not load Code Studio drafts." });
    }
  });

  router.get("/drafts/:id", async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Draft ID is invalid." });
    try {
      const result = await pool.query("SELECT id,title,program_name,source,created_at,updated_at FROM code_studio_drafts WHERE id=$1", [req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Code Studio draft not found." });
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: "Could not load this Code Studio draft." });
    }
  });

  router.post("/drafts", async (req, res) => {
    const draft = normalizeDraft(req.body);
    if (draft.error) return res.status(400).json({ error: draft.error });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "INSERT INTO code_studio_drafts(title,program_name,source) VALUES($1,$2,$3) RETURNING id,title,program_name,source,created_at,updated_at",
        [draft.title, draft.programName, draft.source]
      );
      await saveAudit(client, result.rows[0].id, draft.programName, "CODE_STUDIO_DRAFT_CREATED");
      await client.query("COMMIT");
      res.status(201).json(result.rows[0]);
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      res.status(500).json({ error: "Could not save the Code Studio draft." });
    } finally { client.release(); }
  });

  router.put("/drafts/:id", async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Draft ID is invalid." });
    const draft = normalizeDraft(req.body);
    if (draft.error) return res.status(400).json({ error: draft.error });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "UPDATE code_studio_drafts SET title=$2,program_name=$3,source=$4,updated_at=now() WHERE id=$1 RETURNING id,title,program_name,source,created_at,updated_at",
        [req.params.id, draft.title, draft.programName, draft.source]
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Code Studio draft not found." });
      }
      await saveAudit(client, result.rows[0].id, draft.programName, "CODE_STUDIO_DRAFT_UPDATED");
      await client.query("COMMIT");
      res.json(result.rows[0]);
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      res.status(500).json({ error: "Could not update the Code Studio draft." });
    } finally { client.release(); }
  });

  // Create a separate, versioned workflow artifact for review. The saved
  // Code Studio draft remains unchanged, and no SAP operation is performed.
  router.post("/drafts/:id/prepare-approval", async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Draft ID is invalid." });
    const systemId = typeof req.body?.systemId === "string" ? req.body.systemId : "";
    const system = listMockSystems().find(item => item.id === systemId);
    if (!system) return res.status(400).json({ error: "Choose a valid target SAP profile for the offline quality check." });

    const client = await pool.connect();
    try {
      const saved = await client.query("SELECT id,title,program_name,source FROM code_studio_drafts WHERE id=$1", [req.params.id]);
      if (!saved.rowCount) return res.status(404).json({ error: "Code Studio draft not found. Save the source to JDAP before preparing it for approval." });
      const draft = saved.rows[0];
      const requirement = `Review the Code Studio ABAP source ${draft.program_name} for approval.`;
      const qualityGate = evaluateAbapDraft(draft.source, system, requirement);
      const content = `# JDAP Development Draft\n\n## Execution context\n- Source: saved Code Studio draft ${draft.id}\n- Target profile: ${system.name} (${system.release}) — profile context only\n- Source version: copied from the saved draft; this review artifact is separate\n- SAP repository: not accessed; no SAP object writes occurred\n\n## Requirement\nReview the supplied Code Studio ABAP source for approval.\n\n${renderDraftQualitySections(qualityGate)}## ABAP draft\n\n\`\`\`abap\n${draft.source}\n\`\`\`\n\n---\n**Safety:** Local review artifact only. The offline grammar check does not run SAP syntax, DDIC, ATC, authorization, or runtime validation. No SAP write, activation, transport, or deployment was performed.\n`;
      const workflowResult = { activities: [], system, aiProvider: "CODE STUDIO", selectedAgents: [], generationMode: "CODE_STUDIO_REVIEW", qualityGate, sourceDraftId: draft.id };

      await client.query("BEGIN");
      const workflow = await client.query(
        "INSERT INTO workflows(system_id,prompt,status,result) VALUES($1,$2,'COMPLETED',$3::jsonb) RETURNING id",
        [system.id, requirement, JSON.stringify(workflowResult)]
      );
      const artifact = await client.query(
        "INSERT INTO artifacts(workflow_id,title,artifact_type,content) VALUES($1,$2,'text/markdown',$3) RETURNING id",
        [workflow.rows[0].id, `${draft.program_name}.abap — Code Studio review`, content]
      );
      await client.query(
        "INSERT INTO audit_logs(workflow_id,event,details) VALUES($1,$2,$3::jsonb)",
        [workflow.rows[0].id, "CODE_STUDIO_APPROVAL_DRAFT_PREPARED", JSON.stringify({ sourceDraftId: draft.id, artifactId: artifact.rows[0].id, programName: draft.program_name, qualityGateState: qualityGate.state })]
      );
      await client.query("COMMIT");
      return res.status(201).json({ workflowId: workflow.rows[0].id, artifactId: artifact.rows[0].id, programName: draft.program_name, qualityGate, message: qualityGate.blockers.length ? "A separate review draft was created, but its quality gate is blocked. Correct the source and prepare a new review draft before requesting approval." : "A separate review draft was created with an offline ABAP grammar check. Open Workflow History to request approval." });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return res.status(500).json({ error: "Could not prepare a separate Code Studio review draft." });
    } finally { client.release(); }
  });

  return router;
}
