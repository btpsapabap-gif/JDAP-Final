import { Router } from "express";

export function createAuditRouter(pool) {
  const router = Router();
  router.get("/", async (_req, res) => {
    const r = await pool.query("SELECT id,workflow_id,event,details,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 100");
    res.json(r.rows);
  });
  return router;
}
