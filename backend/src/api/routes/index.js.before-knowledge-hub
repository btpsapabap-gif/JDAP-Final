import { Router } from "express";
import { createHealthRouter } from "./health.js";
import { createCatalogRouter } from "./catalog.js";
import { createWorkflowRouter } from "./workflows.js";
import { createArtifactRouter } from "./artifacts.js";
import { createAuditRouter } from "./audit.js";
import { createSapAdtRouter } from "./sap-adt.js";
import { createSapODataRouter } from "./sap-odata.js";
import { createAbapRouter } from "./abap.js";
import { createApprovalRouter } from "./approvals.js";

export function createApiRouter({ pool, model }) {
  const router = Router();
  router.use("/health", createHealthRouter(pool));
  router.use(createCatalogRouter());
  router.use("/workflows", createWorkflowRouter({ pool, model }));
  router.use("/artifacts", createArtifactRouter(pool));
  router.use("/audit", createAuditRouter(pool));
  router.use("/sap/adt", createSapAdtRouter(pool));
  router.use("/sap/odata", createSapODataRouter());
  router.use("/abap", createAbapRouter());
  router.use("/approvals", createApprovalRouter(pool));
  return router;
}
