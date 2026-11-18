import { Router } from "express";
import { checkAbapGrammar } from "../../integrations/abap-static/checker.js";

export function createAbapRouter() {
  const router = Router();
  router.post("/syntax-check", (req, res) => {
    try {
      const { source, release = "v750" } = req.body || {};
      res.json(checkAbapGrammar(source, release));
    } catch (error) {
      res.status(400).json({ state: "invalid-request", message: error.message });
    }
  });
  return router;
}
