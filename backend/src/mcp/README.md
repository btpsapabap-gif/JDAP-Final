# JDAP MCP server

JDAP exposes an optional local Model Context Protocol server over standard input/output. It offers two read-only tools:

- `search_approved_jdap_guidance`: searches only Knowledge Hub notes marked `workflowApproved: true`, returning up to five attributed excerpts with a total excerpt budget of 6,000 characters.
- `read_approved_jdap_guide`: reads one workflow-approved guide by its ID, capped at 8,000 characters.

The MCP process does not expose HTTP, connect to SAP, read user home folders, or provide approval, Git, transport, SAP creation, or activation operations. Protocol messages use stdout; startup information is written to stderr.

## Run through Docker Compose

From the JDAP project directory, configure the MCP host to launch:

```text
Command: docker
Arguments: compose exec -T backend node /app/src/mcp/server.js
Working directory: the JDAP project directory containing docker-compose.yml
```

The JDAP backend container must be running. The Docker Compose backend image installs the MCP SDK when rebuilt after this change. For a local Node.js run from `backend`, use `npm run mcp` after `npm install`.

The host can discover and call the tools after launching this process. Treat tool output as local working guidance; it is not SAP documentation, target-system validation, or Clean Core evidence.
