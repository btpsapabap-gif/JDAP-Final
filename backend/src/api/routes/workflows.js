import { Router } from "express";
import { executeWorkflow, selectWorkflowAgents } from "../../orchestrator/workflow.js";
import { listMockSystems } from "../../integrations/sap-mock.js";
import { writeAuditEvent } from "../../audit/service.js";
import { resolveAiProvider } from "../../security/provider-policy.js";
import { readSapODataSample } from "../../integrations/sap-odata/client.js";
import { extractAbapSource } from "../../integrations/abap-static/draft-quality.js";
import { retrieveWorkflowKnowledge } from "../../knowledge/service.js";

function asksToCreateAbapSource(prompt = "") {
  const text = String(prompt);
  const creationVerb = /\b(create|generate|build|write|develop|implement)\b[\s\S]{0,60}\b(?:abap|report|program|source|code)\b/i.test(text);
  const explicitlyNegated = /\b(?:do\s+not|don't|never)\s+(?:create|generate|build|write|develop|implement)\b/i.test(text);
  return creationVerb && !explicitlyNegated;
}

function isAbapReviewRequest(prompt = "") {
  const text = String(prompt);
  const requestsReview = /\b(review|reviewing|analy[sz]e|audit|inspect|assess|optimi[sz]e)\b/i.test(text);
  const targetsAbap = /\babap\b/i.test(text) && /\b(report|program|source|code|performance)\b/i.test(text);
  return requestsReview && targetsAbap && !asksToCreateAbapSource(text);
}

function includesAbapSource(prompt = "") {
  const text = String(prompt);
  return /```(?:abap)?\s*[\s\S]*?```/i.test(text)
    || /\b(?:REPORT|PROGRAM)\s+[A-Z][A-Z0-9_]*\s*\./i.test(text)
    || /\bCLASS\s+[A-Z][A-Z0-9_]*\s+(?:DEFINITION|IMPLEMENTATION)\b/i.test(text)
    || /^\s*(?:SELECT(?:-OPTIONS)?\b|PARAMETERS\b|DATA\s*:|TYPES\s*:|METHOD\s+\w+\s*\.|START-OF-SELECTION\.)/im.test(text);
}

function splitTaskAndAbapSource(value = "") {
  const raw = String(value).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  let source = "";
  let task = raw;
  const draftSection = raw.match(/^##\s+ABAP draft\s*\n([\s\S]*?)(?=^##\s|^---\s*$|$)/im)?.[1];
  const fenced = raw.match(/```abap\s*\n([\s\S]*?)```/i);
  if (draftSection) source = extractAbapSource(`## ABAP draft\n${draftSection}`);
  else if (fenced) source = fenced[1].trim();
  else {
    const lines = raw.split("\n");
    const start = lines.findIndex(line => /^\s*(?:REPORT|PROGRAM|CLASS\s+\w+\s+(?:DEFINITION|IMPLEMENTATION)|INTERFACE\s+\w+\s+PUBLIC|FUNCTION-POOL|DEFINE)\b/i.test(line));
    if (start >= 0) {
      source = lines.slice(start).join("\n").trim();
      task = lines.slice(0, start).join("\n").trim();
    }
  }

  // A pasted JDAP artifact can contain a natural-language requirement and a
  // separate source section. Keep the requirement, and discard all other
  // report sections from the task-selection prompt.
  const requirementSection = raw.match(/^##\s+Requirement\s*\n([\s\S]*?)(?=^##\s|^---\s*$|$)/im)?.[1];
  if (requirementSection) {
    const clean = requirementSection.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
    task = clean;
  }
  task = task.replace(/```(?:abap)?[\s\S]*?(?:```|$)/gi, " ").trim();
  const looksLikeCodeOnly = !task || !/[a-z]{3,}\s.{2,}/i.test(task) || includesAbapSource(task);
  if (source && looksLikeCodeOnly) task = "Review the supplied ABAP source for correctness and performance. Return concise findings and recommendations; do not generate a replacement program.";
  return { task: task || raw, source };
}

export function createWorkflowRouter({ pool, model }) {
  const router = Router();

  router.post("/execute", async (req, res) => {
    const { prompt, systemId, aiProvider: requestedAiProvider, includeSapContext = false, includeKnowledgeContext = true, sapEntitySet = "", referenceWorkflowId = "", debugMode = false } = req.body || {};
    let providerSelection;
    try { providerSelection = resolveAiProvider(requestedAiProvider, model, (process.env.AI_PROVIDER || "mock").trim().toLowerCase()); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!prompt?.trim()) return res.status(400).json({ error: "A development prompt is required." });
    if (typeof debugMode !== "boolean") return res.status(400).json({ error: "debugMode must be true or false." });
    const parsedInput = splitTaskAndAbapSource(prompt);
    if (debugMode && req.body?.debugSource !== undefined && typeof req.body.debugSource !== "string") return res.status(400).json({ error: "debugSource must be text." });
    const debugSource = debugMode && typeof req.body?.debugSource === "string" ? req.body.debugSource : parsedInput.source;
    if (debugSource.length > 24000) return res.status(413).json({ error: "The ABAP source is over JDAP's 24,000-character diagnostic limit. Submit a smaller source unit." });
    if (parsedInput.source.length > 24000) return res.status(413).json({ error: "The ABAP source is over JDAP's 24,000-character review limit. Submit a smaller source unit or choose an approved saved draft." });
    const taskPrompt = parsedInput.task;
    if (debugMode && taskPrompt.length > 13000) return res.status(413).json({ error: "Debug diagnostic text must stay under 13,000 characters." });
    const selectedModel = providerSelection.model;
    const system = listMockSystems().find(s => s.id === (systemId || "mock-ecc"));
    if (!system) return res.status(400).json({ error: "Unknown mock system." });
    if (includeSapContext === true && providerSelection.provider === "mock") return res.status(400).json({ error: "Live SAP row context requires a configured AI model provider. Use the SAP Systems page to preview a row while AI is in mock mode." });
    if (typeof includeKnowledgeContext !== "boolean") return res.status(400).json({ error: "includeKnowledgeContext must be true or false." });

    let knowledgeContext = [];
    if (includeKnowledgeContext) {
      try { knowledgeContext = await retrieveWorkflowKnowledge(taskPrompt); }
      catch (error) { return res.status(500).json({ error: `Could not retrieve approved Knowledge Hub guidance: ${error.message}` }); }
    }

    let referenceContext = null;
    if (referenceWorkflowId) {
      if (typeof referenceWorkflowId !== "string" || referenceWorkflowId.length > 80) return res.status(400).json({ error: "Choose a valid saved JDAP workflow as context." });
      try {
        const reference = await pool.query(`
          SELECT w.id, w.prompt, w.result, a.title AS artifact_title, a.content AS artifact_content,
                 r.id AS approval_id
          FROM workflows w
          JOIN artifacts a ON a.workflow_id=w.id
          JOIN approval_requests r ON r.artifact_id=a.id AND r.status='APPROVED'
          WHERE w.id=$1 AND w.status='COMPLETED'
          ORDER BY r.reviewed_at DESC NULLS LAST
          LIMIT 1
        `, [referenceWorkflowId]);
        if (!reference.rowCount) return res.status(404).json({ error: "The selected workflow has no approved saved draft to reuse." });
        const row = reference.rows[0];
        const oldQuality = row.result?.qualityGate;
        if (oldQuality?.state === "BLOCKED") return res.status(422).json({ error: "The selected approved draft has a blocked quality gate and cannot be reused as trusted context. Choose a different approved draft." });
        const source = extractAbapSource(row.artifact_content);
        referenceContext = {
          workflowId: row.id,
          approvalId: row.approval_id,
          title: row.artifact_title,
          originalRequirement: row.prompt,
          programName: source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z][A-Z0-9_]*)/im)?.[1]?.toUpperCase() || null,
          selectionLabels: row.artifact_content.match(/## Selection screen texts\s*([\s\S]*?)(?=\n## |$)/i)?.[1]?.slice(0, 1200) || "",
          approvedSource: source.slice(0, 6000),
          sourceTruncatedForContext: source.length > 6000,
          qualityGateState: oldQuality?.state || "not-recorded"
        };
      } catch (error) { return res.status(500).json({ error: `Could not load the selected approved draft: ${error.message}` }); }
    }

    const sourceReviewMode = !debugMode && Boolean(parsedInput.source) && !asksToCreateAbapSource(taskPrompt);
    const reviewRequest = !debugMode && (isAbapReviewRequest(taskPrompt) || sourceReviewMode);
    const effectiveSourceReviewMode = reviewRequest && Boolean(parsedInput.source || referenceContext?.approvedSource);
    if (!debugMode && isAbapReviewRequest(taskPrompt) && !parsedInput.source && !referenceContext?.approvedSource) {
      return res.status(422).json({ error: "To review ABAP for performance, provide the report source in the developer instruction or select an approved saved draft as context. JDAP will not generate a substitute report for a source-review request." });
    }

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
        [system.id, taskPrompt, "RUNNING"]
      );
      const workflowId = inserted.rows[0].id;
      const aiProvider = providerSelection.provider;
      const selectedAgents = debugMode
        ? selectWorkflowAgents("Debug and troubleshoot this SAP runtime issue using the debugging specialist")
        : effectiveSourceReviewMode
        ? selectWorkflowAgents("Review ABAP source for correctness and performance")
        : selectWorkflowAgents(taskPrompt);
      const sapContextSummary = sapContext ? { source: "SAP OData", entitySet: sapContext.entitySet, transport: sapContext.transport, fields: sapContext.fields, requestedRows: 1, rowsReceived: sapContext.rowsReceived } : null;
      const resumeSafe = !debugMode && !effectiveSourceReviewMode && !sapContext && !referenceContext;
      const completedOutputs = {};
      if (sapContextSummary) await writeAuditEvent(pool, workflowId, "SAP_ODATA_CONTEXT_READ", sapContextSummary);
      const knowledgeReferences = knowledgeContext.map(({ excerpt, score, ...source }) => source);
      if (knowledgeReferences.length) await writeAuditEvent(pool, workflowId, "KNOWLEDGE_CONTEXT_ATTACHED", { sources: knowledgeReferences.map(({ id, title, domain, filename }) => ({ id, title, domain, filename })) });
      res.status(202).json({ id: workflowId, status: "RUNNING", aiProvider, system, selectedAgents, activities: [], knowledgeReferences });

      const activities = [];
      void (async () => {
        try {
          const result = await executeWorkflow({
            prompt: taskPrompt,
            systemId,
            model: selectedModel,
            provider: aiProvider,
            sapContext,
            referenceContext,
            knowledgeContext,
            submittedAbapSource: debugMode ? debugSource : parsedInput.source || referenceContext?.approvedSource || "",
            sourceReviewMode: effectiveSourceReviewMode,
            debugMode,
            onAgent: async event => {
              const { output, ...activityEvent } = event;
              const index = activities.findIndex(item => item.agentId === activityEvent.agentId);
              if (index < 0) activities.push(activityEvent);
              else activities[index] = activityEvent;
              if (typeof output === "string") completedOutputs[activityEvent.agentId] = output;
              await pool.query("UPDATE workflows SET result=$1 WHERE id=$2", [
                JSON.stringify({ activities, outputs: completedOutputs, system, aiProvider, selectedAgents, sapContext: sapContextSummary, resumeSafe, resumeInfo: { includeKnowledgeContext } }), workflowId
              ]);
            }
          });
          const artifactResult = await pool.query(
            "INSERT INTO artifacts(workflow_id,title,artifact_type,content) VALUES($1,$2,$3,$4) RETURNING id",
            [workflowId, result.artifact.title, result.artifact.type, result.artifact.content]
          );
          await pool.query("UPDATE workflows SET status=$1,result=$2 WHERE id=$3", [
            "COMPLETED",
            JSON.stringify({ activities: result.activities, outputs: result.outputs, system: result.system, aiProvider: result.aiProvider, generationMode: result.generationMode, selectedAgents: result.selectedAgents, qualityGate: result.qualityGate, sapContext: sapContextSummary, referenceWorkflowId: referenceContext?.workflowId || null, knowledgeReferences: result.knowledgeReferences || [], resumeSafe, resumeInfo: { includeKnowledgeContext } }),
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
            "FAILED", JSON.stringify({ activities, outputs: completedOutputs, system, aiProvider, selectedAgents, error: e.message, resumeSafe, resumeInfo: { includeKnowledgeContext } }), workflowId
          ]).catch(() => {});
          await writeAuditEvent(pool, workflowId, "WORKFLOW_FAILED", { error: e.message }).catch(() => {});
        }
      })();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/:id/retry", async (req, res) => {
    try {
      const found = await pool.query("SELECT id,system_id,prompt,status,result FROM workflows WHERE id=$1", [req.params.id]);
      if (!found.rowCount) return res.status(404).json({ error: "Workflow not found." });
      const row = found.rows[0];
      const saved = row.result || {};
      if (row.status !== "FAILED") return res.status(409).json({ error: "Only a failed workflow can be resumed." });
      if (saved.resumeSafe !== true || saved.resumeInfo?.includeKnowledgeContext === undefined) return res.status(409).json({ error: "This older or context-dependent workflow cannot be resumed safely. Start a new workflow; completed work was not saved in a resumable format." });
      const selectedAgentIds = (saved.selectedAgents || []).map(item => item.id).filter(Boolean);
      const failedActivity = (saved.activities || []).find(item => item.status === "FAILED");
      if (!failedActivity || !selectedAgentIds.includes(failedActivity.agentId)) return res.status(409).json({ error: "JDAP could not identify the failed specialist in this workflow. Start a new workflow instead." });
      const completedAgentIds = (saved.activities || []).filter(item => item.status === "COMPLETED").map(item => item.agentId);
      const outputs = saved.outputs || {};
      const missingHandoff = completedAgentIds.find(agentId => typeof outputs[agentId] !== "string");
      if (missingHandoff) return res.status(409).json({ error: `JDAP did not save the completed ${missingHandoff} output, so it cannot safely reuse that work. Start a new workflow.` });

      let providerSelection;
      try { providerSelection = resolveAiProvider(saved.aiProvider, model, (process.env.AI_PROVIDER || "mock").trim().toLowerCase()); }
      catch (error) { return res.status(409).json({ error: `The original AI provider is unavailable for resume. ${error.message}` }); }
      const system = listMockSystems().find(item => item.id === row.system_id);
      if (!system) return res.status(409).json({ error: "The workflow's SAP profile is unavailable; it cannot be resumed safely." });
      let knowledgeContext = [];
      if (saved.resumeInfo.includeKnowledgeContext) {
        try { knowledgeContext = await retrieveWorkflowKnowledge(row.prompt); }
        catch (error) { return res.status(500).json({ error: `Could not reload approved Knowledge Hub guidance for resume: ${error.message}` }); }
      }
      const claimed = await pool.query("UPDATE workflows SET status='RUNNING' WHERE id=$1 AND status='FAILED' RETURNING id", [row.id]);
      if (!claimed.rowCount) return res.status(409).json({ error: "This failed workflow has already been resumed or changed." });

      const aiProvider = providerSelection.provider;
      const activities = (saved.activities || []).map(item => ({ ...item }));
      const completedOutputs = { ...outputs };
      await writeAuditEvent(pool, row.id, "WORKFLOW_RESUME_STARTED", { failedAgentId: failedActivity.agentId, reusedCompletedAgentIds: completedAgentIds }).catch(() => {});
      res.status(202).json({ id: row.id, status: "RUNNING", aiProvider, system, selectedAgents: saved.selectedAgents, activities, retryable: false });

      void (async () => {
        try {
          const result = await executeWorkflow({
            prompt: row.prompt,
            systemId: row.system_id,
            model: providerSelection.model,
            provider: aiProvider,
            knowledgeContext,
            resumeOutputs: completedOutputs,
            completedAgentIds,
            resumeActivities: activities,
            agentIdsOverride: selectedAgentIds,
            onAgent: async event => {
              const { output, ...activityEvent } = event;
              const index = activities.findIndex(item => item.agentId === activityEvent.agentId);
              if (index < 0) activities.push(activityEvent);
              else activities[index] = activityEvent;
              if (typeof output === "string") completedOutputs[activityEvent.agentId] = output;
              await pool.query("UPDATE workflows SET result=$1 WHERE id=$2", [
                JSON.stringify({ ...saved, activities, outputs: completedOutputs, system, aiProvider, selectedAgents: saved.selectedAgents, resumeSafe: true, resumeInfo: saved.resumeInfo }), row.id
              ]);
            }
          });
          const artifact = await pool.query(
            "INSERT INTO artifacts(workflow_id,title,artifact_type,content) VALUES($1,$2,$3,$4) RETURNING id",
            [row.id, result.artifact.title, result.artifact.type, result.artifact.content]
          );
          const finalResult = { ...saved, activities: result.activities, outputs: result.outputs, system: result.system, aiProvider: result.aiProvider, generationMode: result.generationMode, selectedAgents: result.selectedAgents, qualityGate: result.qualityGate, referenceWorkflowId: result.referenceWorkflowId, knowledgeReferences: result.knowledgeReferences, resumeSafe: true, resumeInfo: saved.resumeInfo };
          await pool.query("UPDATE workflows SET status='COMPLETED',result=$1 WHERE id=$2", [JSON.stringify(finalResult), row.id]);
          await writeAuditEvent(pool, row.id, "WORKFLOW_RESUME_COMPLETED", { artifactId: artifact.rows[0].id, resumedAgentId: failedActivity.agentId, reusedCompletedAgentIds: completedAgentIds });
        } catch (error) {
          console.error(`JDAP workflow resume ${row.id} failed:`, error.message);
          const activeAgent = activities.find(item => item.status === "RUNNING");
          if (activeAgent) activeAgent.status = "FAILED";
          await pool.query("UPDATE workflows SET status='FAILED',result=$1 WHERE id=$2", [
            JSON.stringify({ ...saved, activities, outputs: completedOutputs, system, aiProvider, selectedAgents: saved.selectedAgents, error: error.message, resumeSafe: true, resumeInfo: saved.resumeInfo }), row.id
          ]).catch(() => {});
          await writeAuditEvent(pool, row.id, "WORKFLOW_RESUME_FAILED", { error: error.message }).catch(() => {});
        }
      })();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/", async (_req, res) => {
    const r = await pool.query(`
      SELECT w.id, w.prompt, w.status, w.system_id, w.created_at,
             w.result->>'aiProvider' AS ai_provider,
             w.result->'selectedAgents' AS selected_agents,
             w.result->'activities' AS activities,
             w.result->'qualityGate'->>'state' AS quality_gate_state,
             (w.status='FAILED' AND w.result->>'resumeSafe'='true' AND jsonb_typeof(w.result->'outputs')='object') AS retryable,
             a.id AS artifact_id, a.title AS artifact_title,
             EXISTS (SELECT 1 FROM approval_requests r WHERE r.artifact_id=a.id AND r.status='APPROVED') AS approved
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
      generationMode: saved.generationMode || "MODEL_GENERATED",
      selectedAgents: saved.selectedAgents || [],
      qualityGate: saved.qualityGate || null,
      referenceWorkflowId: saved.referenceWorkflowId || null,
      system: saved.system || null,
      sapContext: saved.sapContext || null,
      knowledgeReferences: saved.knowledgeReferences || [],
      sapConnectivity: saved.sapContext ? "LIVE ODATA READ ONLY" : "MOCK ONLY",
      activities: saved.activities || [],
      error: saved.error || null,
      retryable: Boolean(row.status === "FAILED" && saved.resumeSafe === true && saved.outputs && typeof saved.outputs === "object"),
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
