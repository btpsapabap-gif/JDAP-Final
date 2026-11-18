import { Router } from "express";
import { checkSapODataEntitySet, checkSapODataService, discoverSapODataMetadata, readSapODataSample } from "../../integrations/sap-odata/client.js";

export function createSapODataRouter() {
  const router = Router();
  router.get("/connection", async (_req, res) => {
    try { res.json(await checkSapODataService()); }
    catch (error) { res.status(400).json({ configured: true, state: "invalid-configuration", message: error.message }); }
  });
  router.get("/read-check", async (_req, res) => {
    try { res.json(await checkSapODataEntitySet(process.env, fetch, String(_req.query.entitySet || ""))); }
    catch (error) { res.status(400).json({ configured: true, state: "invalid-configuration", message: error.message }); }
  });
  router.get("/metadata", async (_req, res) => {
    try {
      const result = await discoverSapODataMetadata();
      res.status(result.state === "discovered" ? 200 : result.state === "not-configured" ? 200 : 502).json(result);
    } catch (error) { res.status(400).json({ configured: true, state: "invalid-configuration", message: error.message }); }
  });
  router.get("/sample", async (_req, res) => {
    try {
      const result = await readSapODataSample(process.env, fetch, String(_req.query.entitySet || ""));
      res.status(result.state === "readable" || result.state === "empty" ? 200 : 502).json(result);
    } catch (error) { res.status(400).json({ configured: true, state: "invalid-configuration", message: error.message }); }
  });
  return router;
}
