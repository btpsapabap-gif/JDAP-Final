import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AGENTS } from "./agents.js";
import { listMockSystems } from "./adapters.js";
import { createModel } from "./model.js";
import { executeWorkflow } from "./orchestrator.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const model = createModel();

async function initializeDatabase() {
  const migrationPath = fileURLToPath(new URL("../../database/migrations/001_init.sql", import.meta.url));
  const migration = await readFile(migrationPath, "utf8");
  await pool.query(migration);
  console.log("JDAP database schema is ready.");
}

app.get("/api/health", async (_req, res) => {
  let db = "unavailable";
  try { await pool.query("SELECT 1"); db = "connected"; } catch {}
  res.json({ status: "ok", application: "JDAP", aiProvider: process.env.AI_PROVIDER || "mock", database: db, sapConnectivity: "MOCK ONLY" });
});
app.get("/api/agents", (_req, res) => res.json(AGENTS));
app.get("/api/systems", async (_req, res) => res.json(listMockSystems()));
app.post("/api/workflows/execute", async (req, res) => {
  const { prompt, systemId, aiProvider: requestedAiProvider } = req.body || {};
  if (requestedAiProvider && !["mock", "openai"].includes(requestedAiProvider)) {
    return res.status(400).json({ error: "aiProvider must be 'mock' or 'openai'." });
  }
  if (requestedAiProvider === "openai" && !model) {
    return res.status(400).json({ error: "OpenAI AI mode is not configured on this JDAP server." });
  }
  if (!prompt?.trim()) return res.status(400).json({ error: "A development prompt is required." });
  const selectedModel = requestedAiProvider === "mock" ? null : model;
  const system = listMockSystems().find(s => s.id === (systemId || "mock-ecc"));
  if (!system) return res.status(400).json({ error: "Unknown mock system." });

  try {
    const inserted = await pool.query(
      "INSERT INTO workflows(system_id,prompt,status) VALUES($1,$2,$3) RETURNING id",
      [system.id, prompt, "RUNNING"]
    );
    const workflowId = inserted.rows[0].id;
    const aiProvider = selectedModel ? "openai" : "mock";
    res.status(202).json({ id: workflowId, status: "RUNNING", aiProvider, system, activities: [] });

    const activities = [];
    void (async () => {
      try {
        const result = await executeWorkflow({
          prompt,
          systemId,
          model: selectedModel,
          onAgent: async event => {
            const index = activities.findIndex(item => item.agentId === event.agentId);
            if (index < 0) activities.push(event);
            else activities[index] = event;
            await pool.query("UPDATE workflows SET result=$1 WHERE id=$2", [
              JSON.stringify({ activities, system, aiProvider }), workflowId
            ]);
          }
        });
        const artifactResult = await pool.query(
          "INSERT INTO artifacts(workflow_id,title,artifact_type,content) VALUES($1,$2,$3,$4) RETURNING id",
          [workflowId, result.artifact.title, result.artifact.type, result.artifact.content]
        );
        await pool.query("UPDATE workflows SET status=$1,result=$2 WHERE id=$3", [
          "COMPLETED",
          JSON.stringify({ activities: result.activities, system: result.system, aiProvider: result.aiProvider }),
          workflowId
        ]);
        await pool.query("INSERT INTO audit_logs(workflow_id,event,details) VALUES($1,$2,$3)", [
          workflowId, "WORKFLOW_COMPLETED",
          JSON.stringify({ systemId: system.id, agentCount: result.activities.length, artifactId: artifactResult.rows[0].id })
        ]);
      } catch (e) {
        console.error(`JDAP workflow ${workflowId} failed:`, e.message);
        const activeAgent = activities.find(item => item.status === "RUNNING");
        if (activeAgent) activeAgent.status = "FAILED";
        await pool.query("UPDATE workflows SET status=$1,result=$2 WHERE id=$3", [
          "FAILED", JSON.stringify({ activities, system, aiProvider, error: e.message }), workflowId
        ]).catch(() => {});
        await pool.query("INSERT INTO audit_logs(workflow_id,event,details) VALUES($1,$2,$3)", [
          workflowId, "WORKFLOW_FAILED", JSON.stringify({ error: e.message })
        ]).catch(() => {});
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/workflows", async (_req, res) => {
  const r = await pool.query(`
    SELECT w.id, w.prompt, w.status, w.system_id, w.created_at,
           w.result->>'aiProvider' AS ai_provider,
           w.result->'activities' AS activities,
           a.id AS artifact_id, a.title AS artifact_title
    FROM workflows w
    LEFT JOIN artifacts a ON a.workflow_id = w.id
    ORDER BY w.created_at DESC
    LIMIT 100
  `);
  res.json(r.rows);
});
app.get("/api/workflows/:id", async (req, res) => {
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
    system: saved.system || null,
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
app.get("/api/artifacts/:id", async (req, res) => {
  const r = await pool.query("SELECT * FROM artifacts WHERE id=$1", [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Artifact not found" });
  res.json(r.rows[0]);
});
app.get("/api/audit", async (_req, res) => {
  const r = await pool.query("SELECT id,workflow_id,event,details,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 100");
  res.json(r.rows);
});
const port = Number(process.env.PORT || 4001);
initializeDatabase().then(() => {
  app.listen(port, () => console.log(`JDAP API listening on ${port}`));
}).catch(error => {
  console.error("JDAP could not initialize its database:", error.message);
  process.exitCode = 1;
  pool.end().finally(() => process.exit());
});
