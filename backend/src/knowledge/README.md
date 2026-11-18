# Knowledge Hub

The Knowledge Hub reads local Markdown guidance from `knowledge-base/` and exposes browse and search endpoints under `/api/knowledge`. Workflow retrieval only considers files marked `workflowApproved: true` in frontmatter, selects up to three matching guides, and attaches bounded excerpts and source references to the saved workflow and audit record. Users may turn this context off in AI Developer.

The optional MCP server exposes the same approved-guide boundary through two read-only tools: search with up to five short attributed excerpts, and read one guide by ID with an 8,000-character limit. It uses stdio and does not connect to SAP or external documentation. See `backend/src/mcp/README.md`.

This is local JDAP working guidance, not authoritative SAP documentation or Clean Core evidence. Confirm SAP behavior, release contracts, authorization, and ATC status in the target system.
