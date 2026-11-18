import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createModel } from "../integrations/openai/client.js";
import { createApiRouter } from "./routes/index.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const model = createModel();
app.use("/api", createApiRouter({ pool, model }));

async function initializeDatabase() {
  const migrationPath = fileURLToPath(new URL("../../../database/migrations/001_init.sql", import.meta.url));
  const seedPath = fileURLToPath(new URL("../../../database/seed/001_demo.sql", import.meta.url));
  const migration = await readFile(migrationPath, "utf8");
  const seed = await readFile(seedPath, "utf8");
  await pool.query(migration);
  await pool.query(seed);
  console.log("JDAP database schema is ready.");
}

const port = Number(process.env.PORT || 4001);
initializeDatabase().then(() => {
  app.listen(port, () => console.log(`JDAP API listening on ${port}`));
}).catch(error => {
  console.error("JDAP could not initialize its database:", error.message);
  process.exitCode = 1;
  pool.end().finally(() => process.exit());
});
