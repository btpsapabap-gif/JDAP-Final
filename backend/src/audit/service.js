export async function writeAuditEvent(pool, workflowId, event, details) {
  await pool.query(
    "INSERT INTO audit_logs(workflow_id,event,details) VALUES($1,$2,$3)",
    [workflowId, event, JSON.stringify(details || {})]
  );
}
