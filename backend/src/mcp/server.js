import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { getKnowledge, retrieveWorkflowKnowledge } from "../knowledge/service.js";

const MAX_QUERY_LENGTH = 120;
const MAX_EXCERPT_LENGTH = 6000;

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function createServer() {
  const server = new McpServer({ name: "jdap", version: "1.0.0" });

  server.registerTool("search_approved_jdap_guidance", {
    title: "Search approved JDAP guidance",
    description: "Searches the local JDAP Knowledge Hub for workflow-approved working guidance. Returns short attributed excerpts; it does not access SAP or external documentation.",
    inputSchema: z.object({
      query: z.string().trim().min(3).max(MAX_QUERY_LENGTH).describe("Search topic, up to 120 characters"),
      maxResults: z.number().int().min(1).max(5).optional().describe("Maximum number of matching guides (default 3)")
    })
  }, async ({ query, maxResults }) => {
    const results = await retrieveWorkflowKnowledge(query, {
      maxItems: maxResults ?? 3,
      maxChars: MAX_EXCERPT_LENGTH
    });
    return textResult({
      source: "JDAP local Knowledge Hub",
      results: results.map(({ score, ...item }) => item),
      note: "Working guidance only. Verify SAP behavior, release contracts, authorization, and Clean Core status in the target system."
    });
  });

  server.registerTool("read_approved_jdap_guide", {
    title: "Read an approved JDAP guide",
    description: "Reads one workflow-approved local Knowledge Hub guide by its ID, capped at 8,000 characters. No external or SAP source is read.",
    inputSchema: z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/).describe("Knowledge Hub guide ID")
    })
  }, async ({ id }) => {
    const document = await getKnowledge(id);
    if (!document || !document.workflowApproved) {
      return { content: [{ type: "text", text: "No workflow-approved Knowledge Hub guide matches that ID." }], isError: true };
    }
    return textResult({
      id: document.id,
      title: document.title,
      summary: document.summary,
      domain: document.domain,
      filename: document.filename,
      sourceName: document.sourceName,
      sourceUrl: document.sourceUrl,
      content: document.content.slice(0, 8000),
      truncated: document.content.length > 8000,
      note: "Local JDAP working guidance, not authoritative SAP documentation or compliance evidence."
    });
  });

  return server;
}

void serveStdio(createServer);
console.error("JDAP MCP server ready on stdio (read-only Knowledge Hub tools).");
