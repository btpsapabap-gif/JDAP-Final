import { Router } from "express";

export function createArtifactRouter(pool) {
  const router = Router();
  router.get("/:id", async (req, res) => {
    const r = await pool.query("SELECT * FROM artifacts WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Artifact not found" });
    res.json(r.rows[0]);
  });
  return router;
}
