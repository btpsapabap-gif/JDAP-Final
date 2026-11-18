import { Router } from "express";

export function createHealthRouter(pool) {
  const router = Router();
  router.get("/", async (_req, res) => {
    let database = "unavailable";
    try { await pool.query("SELECT 1"); database = "connected"; } catch {}
    res.json({ status: "ok", application: "JDAP", aiProvider: (process.env.AI_PROVIDER || "mock").trim().toLowerCase(), database, sapConnectivity: "MOCK ONLY" });
  });
  return router;
}
