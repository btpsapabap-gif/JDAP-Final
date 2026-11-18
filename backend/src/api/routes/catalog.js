import { Router } from "express";
import { AGENTS } from "../../agents/registry.js";
import { listMockSystems } from "../../integrations/sap-mock.js";

export function createCatalogRouter() {
  const router = Router();
  router.get("/agents", (_req, res) => res.json(AGENTS));
  router.get("/systems", (_req, res) => res.json(listMockSystems()));
  return router;
}
