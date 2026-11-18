import { Router } from "express";
import { writeAuditEvent } from "../../audit/service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createProjectsRouter(pool) {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT p.id, p.name, p.description, p.created_at,
               COUNT(w.id)::int AS workflow_count,
               MAX(w.created_at) AS last_activity,
               COALESCE(json_agg(json_build_object(
                 'id', w.id, 'prompt', w.prompt, 'status', w.status,
                 'systemId', w.system_id, 'createdAt', w.created_at,
                 'artifactId', a.id, 'artifactTitle', a.title,
                 'qualityGateState', w.result->'qualityGate'->>'state'
               ) ORDER BY w.created_at DESC) FILTER (WHERE w.id IS NOT NULL), '[]'::json) AS workflows
        FROM projects p
        LEFT JOIN workflows w ON w.project_id=p.id
        LEFT JOIN LATERAL (
          SELECT id, title FROM artifacts WHERE workflow_id=w.id ORDER BY created_at DESC LIMIT 1
        ) a ON TRUE
        GROUP BY p.id
        ORDER BY COALESCE(MAX(w.created_at), p.created_at) DESC
      `);
      res.json(result.rows);
    } catch {
      res.status(500).json({ error: "Could not load JDAP projects." });
    }
  });

  router.get("/unassigned-workflows", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, prompt, system_id, status, created_at
        FROM workflows
        WHERE project_id IS NULL AND status='COMPLETED'
        ORDER BY created_at DESC LIMIT 100
      `);
      res.json(result.rows);
    } catch {
      res.status(500).json({ error: "Could not load unassigned completed workflows." });
    }
  });

  router.post("/", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    if (!name || name.length > 120) return res.status(400).json({ error: "Project name is required and must be 120 characters or fewer." });
    if (description.length > 1000) return res.status(400).json({ error: "Project description must be 1,000 characters or fewer." });
    try {
      const result = await pool.query("INSERT INTO projects(name,description) VALUES($1,$2) RETURNING id,name,description,created_at", [name, description]);
      await writeAuditEvent(pool, null, "PROJECT_CREATED", { projectId: result.rows[0].id, name });
      res.status(201).json({ ...result.rows[0], workflow_count: 0, workflows: [] });
    } catch (error) {
      res.status(500).json({ error: "Could not create this project." });
    }
  });

  router.post("/:id/workflows/:workflowId", async (req, res) => {
    const { id, workflowId } = req.params;
    if (!UUID.test(id) || !UUID.test(workflowId)) return res.status(400).json({ error: "Project or workflow ID is invalid." });
    try {
      const project = await pool.query("SELECT id,name FROM projects WHERE id=$1", [id]);
      if (!project.rowCount) return res.status(404).json({ error: "Project not found." });
      const workflow = await pool.query("SELECT id,project_id,status FROM workflows WHERE id=$1", [workflowId]);
      if (!workflow.rowCount) return res.status(404).json({ error: "Workflow not found." });
      if (workflow.rows[0].status !== "COMPLETED") return res.status(409).json({ error: "Only completed workflows can be added to a project." });
      if (workflow.rows[0].project_id && workflow.rows[0].project_id !== id) return res.status(409).json({ error: "This workflow is already assigned to another project. JDAP did not move it." });
      const assigned = await pool.query("UPDATE workflows SET project_id=$1 WHERE id=$2 AND project_id IS NULL RETURNING id", [id, workflowId]);
      if (!assigned.rowCount && workflow.rows[0].project_id !== id) return res.status(409).json({ error: "This workflow was assigned elsewhere while you were adding it. Refresh the project list." });
      if (!assigned.rowCount) return res.json({ projectId: id, workflowId, assigned: true, alreadyAssigned: true });
      await writeAuditEvent(pool, workflowId, "WORKFLOW_ADDED_TO_PROJECT", { projectId: id, projectName: project.rows[0].name });
      res.json({ projectId: id, workflowId, assigned: true });
    } catch {
      res.status(500).json({ error: "Could not add this workflow to the project." });
    }
  });

  return router;
}
