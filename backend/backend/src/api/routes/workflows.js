import { Router } from "express";
import { executeWorkflow, selectWorkflowAgents } from "../../orchestrator/workflow.js";
import { listMockSystems } from "../../integrations/sap-mock.js";
import { writeAuditEvent } from "../../audit/service.js";
import { resolveAiProvider } from "../../security/provider-policy.js";
import { readSapODataSample } from "../../integrations/sap-odata/client.js";

export function createWorkflowRouter({ pool, model }) {
  const router = Router();

  router.post("/execute", async (req, res) => {
    const { prompt, systemId, aiProvider: requestedAiProvider, includeSapContext = false, sapEntitySet = "" } = req.body || {};
    let providerSelection;
    try { providerSelection = resolveAiProvider(requestedAiProvider, model, (process.env.AI_PROVIDER || "mock").trim().toLowerCase()); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!prompt?.trim()) return res.status(400).json({ error: "A development prompt is required." });
    const selectedModel = providerSelection.model;
    const system = listMockSystems().find(s => s.id === (systemId || "mock-ecc"));
    if (!system) return res.status(400).json({ error: "Unknown mock system." });
    if (includeSapContext === true && providerSelection.provider === "mock") return res.status(400).json({ error: "Live SAP row context requires a configured AI model provider. Use the SAP Systems page to preview a row while AI is in mock mode." });

    let sapContext = null;
    if (includeSapContext === true) {
      try {
        sapContext = await readSapODataSample(process.env, fetch, sapEntitySet);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      if (sapContext.state !== "readable") return res.status(502).json({ error: sapContext.message || `Live SAP context unavailable (${sapContext.state}).`, sapState: sapContext.state });
    }

    try {
      const inserted = await pool.query(
        "INSERT INTO workflows(system_id,prompt,status) VALUES($1,$2,$3) RETURNING id",
        [system.id, prompt, "RUNNING"]
      );
      const workflowId = inserted.rows[0].id;
      const aiProvider = providerSelection.provider;
      const selectedAgents = selectWorkflowAgents(prompt);
      const sapContextSummary = sapContext ? { source: "SAP OData", entitySet: sapContext.entitySet, transport: sapContext.transport, fields: sapContext.fields, requestedRows: 1, rowsReceived: sapContext.rowsReceived } : null;
      if (sapContextSummary) await writeAuditEvent(pool, workflowId, "SAP_ODATA_CONTEXT_READ", sapContextSummary);
      res.status(202).json({ id: workflowId, status: "RUNNING", aiProvider, system, selectedAgents, activities: [] });

      const activities = [];
      void (async () => {
        try {
          const result = await executeWorkflow({
            prompt,
            systemId,
            model: selectedModel,
            provider: aiProvider,
            sapContext,
            onAgent: async event => {
              const index = activities.findIndex(item => item.agentId === event.agentId);
              if (index < 0) activities.push(event);
              else activities[index] = event;
              await pool.query("UPDATE workflows SET result=$1 WHERE id=$2", [
            JSON.stringify({ activities, system, aiProvider, selectedAgents, sapContext: sapContextSummary }), workflowId
              ]);
            }
          });
          const artifactResult = await pool.query(
            "INSERT INTO artifacts(workflow_id,title,artifact_type,content) VALUES($1,$2,$3,$4) RETURNING id",
            [workflowId, result.artifact.title, result.artifact.type, result.artifact.content]
          );
          await pool.query("UPDATE workflows SET status=$1,result=$2 WHERE id=$3", [
            "COMPLETED",
            JSON.stringify({ activities: result.activities, system: result.system, aiProvider: result.aiProvider, selectedAgents: result.selectedAgents, qualityGate: result.qualityGate, sapContext: sapContextSummary }),
            workflowId
          ]);
          await writeAuditEvent(pool, workflowId, "WORKFLOW_COMPLETED", {
            systemId: system.id, agentCount: result.activities.length, artifactId: artifactResult.rows[0].id, sapContext: sapContextSummary
          });
        } catch (e) {
          console.error(`JDAP workflow ${workflowId} failed:`, e.message);
          const activeAgent = activities.find(item => item.status === "RUNNING");
          if (activeAgent) activeAgent.status = "FAILED";
          await pool.query("UPDATE workflows SET status=$1,result=$2 WHERE id=$3", [
            "FAILED", JSON.stringify({ activities, system, aiProvider, selectedAgents, error: e.message }), workflowId
          ]).catch(() => {});
          await writeAuditEvent(pool, workflowId, "WORKFLOW_FAILED", { error: e.message }).catch(() => {});
        }
      })();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/", async (_req, res) => {
    const r = await pool.query(`
      SELECT w.id, w.prompt, w.status, w.system_id, w.created_at,
             w.result->>'aiProvider' AS ai_provider,
             w.result->'selectedAgents' AS selected_agents,
             w.result->'activities' AS activities,
             a.id AS artifact_id, a.title AS artifact_title
      FROM workflows w
      LEFT JOIN artifacts a ON a.workflow_id = w.id
      ORDER BY w.created_at DESC
      LIMIT 100
    `);
    res.json(r.rows);
  });

  router.get("/:id", async (req, res) => {
    const r = await pool.query(`
      SELECT w.*, a.id AS artifact_id, a.title AS artifact_title,
             a.artifact_type, a.content AS artifact_content
      FROM workflows w
      LEFT JOIN artifacts a ON a.workflow_id = w.id
      WHERE w.id=$1
    `, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Workflow not found" });
    const row = r.rows[0];
    const saved = row.result || {};
    res.json({
      id: row.id,
      status: row.status,
      aiProvider: saved.aiProvider || null,
      selectedAgents: saved.selectedAgents || [],
      qualityGate: saved.qualityGate || null,
      system: saved.system || null,
      sapContext: saved.sapContext || null,
      sapConnectivity: saved.sapContext ? "LIVE ODATA READ ONLY" : "MOCK ONLY",
      activities: saved.activities || [],
      error: saved.error || null,
      artifact: row.artifact_id ? {
        id: row.artifact_id,
        title: row.artifact_title,
        type: row.artifact_type,
        content: row.artifact_content
      } : null
    });
  });
  return router;
}
