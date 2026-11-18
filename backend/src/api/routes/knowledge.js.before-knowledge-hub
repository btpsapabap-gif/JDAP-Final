import { Router } from "express";
import { getKnowledge, knowledgeDomains, listKnowledge } from "../../knowledge/service.js";

export function createKnowledgeRouter() {
  const router = Router();

  router.get("/", async (req, res) => {
    const query = String(req.query.q || "").trim();
    const domain = String(req.query.domain || "").trim().toLowerCase();
    if (query.length > 120) return res.status(400).json({ error: "Search text must be 120 characters or less." });
    if (domain && domain !== "all" && !knowledgeDomains.includes(domain)) return res.status(400).json({ error: "Unknown knowledge domain." });
    try {
      res.json({ domains: knowledgeDomains, items: await listKnowledge({ query, domain }) });
    } catch (error) { res.status(500).json({ error: `Could not read the local knowledge base: ${error.message}` }); }
  });

  router.get("/:id", async (req, res) => {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid knowledge item ID." });
    try {
      const document = await getKnowledge(req.params.id);
      if (!document) return res.status(404).json({ error: "Knowledge item not found." });
      res.json(document);
    } catch (error) { res.status(500).json({ error: `Could not read the local knowledge item: ${error.message}` }); }
  });

  return router;
}
