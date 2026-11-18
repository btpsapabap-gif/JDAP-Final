# JDAP — Joule Developer Agent Platform

A local SAP developer-agent workbench. It includes a React UI, Node.js API, 12 specialist agents, a task-based orchestrator, PostgreSQL persistence, MOCK/OpenAI/local Ollama model providers, ECC/S/4HANA/BTP demo profiles, a read-only SAP OData adapter with opt-in workflow context, and offline plus SAP-native ABAP checks.

> **Connectivity status:** SAP OData metadata and explicit read-only entity-set/sample requests are live when configured. SAP ADT supports opt-in source reads, separately gated approved-report creation, approved selection-text updates, and a separately gated activation request. The selection-text and activation write paths must be verified on the target SAP system before operational use.

## Backend module layout
- `backend/src/api`: startup entry point plus separate health, catalog, workflow, artifact, and audit route modules
- `backend/src/agents`: shared runner/registry plus 12 specialist-owned folders and mock response handlers
- `backend/src/orchestrator`: workflow sequencing and bounded agent handoffs
- `backend/src/integrations/openai`: OpenAI Responses API and local Ollama-compatible chat client
- `backend/src/integrations/sap-ecc`, `sap-s4`, `sap-btp`: mock system profiles and fixtures
- `backend/src/integrations/sap-adt`: SAP ADT discovery, source reads, native syntax checks for active/inactive versions, approved report creation, selection-text updates, and activation
- `backend/src/integrations/sap-odata`: read-only SAP Gateway OData V2 metadata and explicit entity-set checks
- `backend/src/integrations/abap-static`: offline ABAP grammar checking against a selected on-premise release
- `backend/src/audit` and `backend/src/security`: audit persistence and provider selection policy
- `backend/src/mcp`: optional stdio MCP server with read-only approved Knowledge Hub search and read tools
- `backend/src/knowledge`: local Markdown guidance, browse/search endpoints, and bounded approved-guide retrieval for workflows
- `backend/src/integrations/git`: reserved for a Git provider adapter in this package snapshot
- `database/migrations` and `database/seed`: repeatable schema setup and separate demo data

## Frontend module layout
- `frontend/src/App.jsx`: shared application state and page routing
- `frontend/src/components`: navigation, status bar, agent lists, and system cards
- `frontend/src/pages`: Overview, AI Developer, My Projects, Code Studio, Workflow History, Approvals, Testing Center, Audit & Analytics, and registered-module views
- `frontend/src/pages/TestingCenter.jsx`: ABAP grammar check for draft source, SAP-native syntax check for an active program, and an SAP syntax gate before approved report activation
- `frontend/src/dashboard`, `frontend/src/chat`, `frontend/src/agents`: dashboard cards, task composer, and agent directory modules
- `frontend/src/main.jsx`: browser entry point and stylesheet loading

## Requirements
- Docker Desktop running with Docker Compose
- No separate Windows PostgreSQL installation is required; Compose starts the JDAP PostgreSQL container

## Windows quick start (Docker Desktop)

1. Extract this ZIP. In File Explorer, open the extracted `JDAP-Docker-5433` folder and enter `powershell` in the address bar to open PowerShell there.
2. Create the environment file:
   ```powershell
   Copy-Item .env.example .env
   ```
3. Leave `AI_PROVIDER=mock` for offline mock mode. No API key is needed for that mode.
4. Start the complete stack:
   ```powershell
   docker compose up --build -d
   ```
5. Check that all services are running:
   ```powershell
   docker compose ps
   docker compose logs --tail 50 backend
   ```
   Wait for `JDAP database schema is ready` and `JDAP API listening on 4001` in the backend log.
6. Open **http://localhost:4000**. API health: **http://localhost:4001/api/health**.

The Compose PostgreSQL container is reachable by the backend at `postgres:5432` inside Docker. Its optional Windows host mapping is `localhost:5433` (database `jdap`, user/password `jdap`); this does not change the backend connection. If host port 5433 is already occupied, change the left side of `5433:5432` in `docker-compose.yml` to a free port such as `5434:5432`, then run `docker compose up -d` again.

To stop the stack, run `docker compose down`. This keeps the database volume. To also erase all JDAP database data, run `docker compose down -v`.

## First run
- The database schema is initialized from `database/migrations/001_init.sql`; demo rows are kept separately in `database/seed/001_demo.sql`.
- The UI seeds the demo project and system profiles through the API on first use.
- Select a mock system (`ECC 6.0`, `S/4HANA`, or `BTP`) and submit a development task.
- The workflow selects specialists from explicit requested deliverables instead of invoking every agent when a requirement merely mentions a technology or constraint. A focused ABAP report request runs the ABAP specialist; testing, security, CDS/RAP, Fiori, integration, debugging, documentation, compatibility, and DevOps specialists are added when their distinct work is requested. Architecture runs for an explicit architecture/design task. The AI Developer page shows the selected team and live status. Mock-mode steps are paced for a visible demo (`MOCK_AGENT_STEP_DELAY_MS`, default 200 ms). Agents receive bounded handoffs from selected earlier specialists. Open **Workflow History** to revisit agent activity and download the latest 100 saved drafts.
- After model-generated ABAP is produced, JDAP runs its offline quality gate and can make up to two parser-guided repair attempts, keeping only candidates that improve the gate. The report remains blocked when issues persist; SAP syntax, DDIC, ATC, API release, and authorization checks still require the target system.
- Generated report declarations are normalized when the model returns an invalid program name, and the quality gate checks `SELECT SINGLE *` even when an `INTO` clause appears before `FROM`. For display-only requirements, detected database write statements are also blocking findings.
- When a standard generation workflow fails after a specialist completed, the completed handoffs are saved. **Resume from failed agent** reruns the failed specialist and remaining selected agents while reusing completed outputs. Runs that used live OData samples, approved-reference context, source review, or Debug Center are not resumed; older failures without saved handoffs require a fresh run.
- Open **Testing Center** to load the latest generated ABAP draft from the current session or saved history, or paste source. The default grammar target is SAP_BASIS 7.50 for the connected ECC/NetWeaver system.
- In **Workflow History**, open a saved draft and request a local review. The persisted **Approvals** queue records a reviewer decision and audit event. This is a local governance checkpoint only; approval does not call SAP or create, activate, transport, or deploy an object.
- **Code Studio** opens saved workflow or standalone sources for local editing. “Save to JDAP” stores a separate Code Studio draft; it never overwrites the original workflow artifact or writes to SAP. Sources can also be copied or downloaded as `.abap` files.
- **Debug Center** sends pasted SAP errors and optional ABAP source to the focused Debugging Specialist. It validates source-linked findings against exact one-based lines and quoted evidence, and includes suggested corrections when supplied. The analysis is stored in Workflow History; diagnostic text and source are persisted with that workflow, so redact secrets and business data first. It does not connect to SAP or run code.
- **Audit & Analytics** displays the latest 100 persisted JDAP events with event-type filtering, text search, workflow references, and expandable event details. The view is read-only.
- **My Projects** creates local project workspaces and organizes completed workflows. Assignment updates only the workflow's project association; source, approval, SAP objects, transports, and GitHub remain unchanged.
- **Overview** summarizes recent workflow activity, pending local approvals, project count, and current service indicators. It is read-only and refreshes from the existing JDAP APIs.
- Approved drafts can be exported from **Approvals** as a JSON handoff containing the saved draft, extracted ABAP source when present, and the review record. It is for manual developer handling; JDAP does not create a SAP repository object or transport from this export.
- Artifacts are drafts only. No SAP object is created, activated, transported or deployed.

## OpenAI model configuration

The AI provider and SAP connection are separate. To use OpenAI for the agent responses while keeping the SAP landscape in mock mode, set these values in `.env`:
```env
AI_PROVIDER=openai
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4.1-mini
```
Then rebuild the backend with `docker compose up -d --build --force-recreate backend`. The app header will show `AI: OPENAI` and `SAP: MOCK`. With `AI_PROVIDER=mock`, it shows `AI: MOCK` and `SAP: MOCK`. The OpenAI adapter uses the Responses API. If a model call fails, the workflow reports the error instead of silently claiming a successful AI response. Only send code and data to OpenAI when your organization's policies permit it.

If OpenAI returns a credit or quota error, the AI Developer page offers **Retry using mock AI**. This starts a new workflow explicitly labeled `AI: MOCK`; it does not silently change the provider or require editing `.env`.

## Local Ollama model configuration

JDAP can also send agent prompts to an Ollama server through Ollama's OpenAI-compatible chat-completions endpoint. This avoids an OpenAI API account and per-request OpenAI credits, but the selected local model must be downloaded and running on the Windows host. Model quality and generation speed depend on the model and computer; review and validate every generated draft.

1. Install and start Ollama on Windows, then pull a model supported by your machine. Confirm it appears in `ollama list`.
2. Edit `.env` and set the exact model tag shown by `ollama list`:
   ```env
   AI_PROVIDER=ollama
   OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
   OLLAMA_MODEL=your-installed-model-tag
   OLLAMA_TIMEOUT_MS=900000
   OLLAMA_MAX_TOKENS=512
   OLLAMA_ABAP_MAX_TOKENS=1800
   ```
3. Recreate the backend: `docker compose up -d --build --force-recreate backend`.
4. Check `http://localhost:4001/api/health`; `aiProvider` should report `ollama`. JDAP sends one model request per selected specialist, in sequence. The selected team is shown in the workflow progress panel. Ollama requests are capped at 512 output tokens for support specialists and 1800 for ABAP by default, with a 15-minute request timeout for slower CPU-only systems. Tune these values in `.env` if needed.

The default URL is for Ollama running on the same Windows host as Docker Desktop. If Ollama runs elsewhere, use its reachable OpenAI-compatible base URL. SAP OData sample context can be enabled for an Ollama workflow; JDAP displays a confirmation before sending a sample to the configured endpoint. A remote endpoint is not local merely because the provider is named Ollama.

## Optional SAP ADT connectivity check (read-only)

Mock SAP remains the default. JDAP only contacts an SAP server when you explicitly configure the values below and request `GET http://localhost:4001/api/sap/adt/connection`. The request is a GET to SAP's ADT discovery resource; it checks reachability and authentication only. A successful response does **not** mean JDAP is reading source code or connected for development operations.

For an SAP HTTPS endpoint, add these values to `.env` (never share or commit this file):
```env
SAP_ADT_BASE_URL=https://your-sap-host:port
SAP_ADT_ALLOW_HTTP=false
SAP_ADT_CLIENT=100
SAP_ADT_USERNAME=your_read_only_user
SAP_ADT_PASSWORD=your_password
SAP_ADT_TIMEOUT_MS=8000
```

For this installation's SAP HTTP route, use the reachable port 8014 and explicitly allow HTTP:
```env
SAP_ADT_BASE_URL=http://103.89.45.155:8014
SAP_ADT_ALLOW_HTTP=true
SAP_ADT_CLIENT=200
```
If `SAP_ADT_USERNAME`, `SAP_ADT_PASSWORD`, or `SAP_ADT_CLIENT` are blank, JDAP reuses the corresponding `SAP_ODATA_*` value. Dedicated `SAP_ADT_*` values take precedence when supplied.

The SAP administrator must expose the ADT ICF service and grant the user only the ADT discovery/read permissions required by your release. The connection check issues a read-only `GET /sap/bc/adt/discovery`. HTTP sends Basic credentials without encryption; use it only on your approved protected network. HTTP must be explicitly enabled with `SAP_ADT_ALLOW_HTTP=true`; HTTPS certificate verification remains enabled and is never bypassed. Recreate the backend after editing `.env`:
```powershell
docker compose up -d --force-recreate backend
Invoke-RestMethod http://localhost:4001/api/sap/adt/connection
```

Possible states include `not-configured`, `reachable`, `missing-credentials`, `unauthorized`, `adt-not-found`, `timeout`, and `unreachable`. Passwords and authorization headers are not returned or logged. A reachable ADT discovery endpoint does not mean source retrieval or writes are authorized. Each source read and SAP write is independently gated.

If SAP uses a private/self-signed TLS certificate, obtain the PEM-encoded issuing CA certificate or approved self-signed server certificate from your SAP Basis/security administrator (never a private key). Place it at `certs/sap-ca.pem`, then set `NODE_EXTRA_CA_CERTS=/run/certs/sap-ca.pem` in `.env`. The backend container mounts `./certs` read-only and Node adds that certificate to its trust list while normal TLS verification stays enabled. Recreate the backend after changing the certificate or `.env`. If the certificate is renewed, replace the PEM file with the new approved certificate. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### Optional ABAP program source read

For a controlled read-only source retrieval, set `SAP_ADT_ENABLE_SOURCE_READ=true` and configure a separate random `SAP_ADT_READ_API_TOKEN` in `.env`. Keep the token private. The **Testing Center** can retrieve one existing ABAP program using that token. The API requires `Authorization: Bearer <token>`, allows one simple program name per request, and limits the response to 1 MiB. The token is held only in the page state for the request; retrieved source is not added to workflow history. Use a read-only SAP account. The endpoint only performs an ADT GET; it does not modify SAP. The API token protects this route, but JDAP as a whole does not yet have user sign-in, so only expose the Docker ports on a trusted developer machine/network. For the HTTP route used in this setup, SAP credentials and source text are unencrypted in transit.

After recreating the backend, retrieve a program from PowerShell (replace the example program and token with your own):
```powershell
$headers = @{ Authorization = "Bearer <your-JDAP-token>" }
Invoke-RestMethod -Headers $headers "http://localhost:4001/api/sap/adt/programs/Z_MY_REPORT/source"
```

This fetch route is not part of workflows. Live retrieval still requires the configured HTTP/HTTPS endpoint and SAP-side ADT authorization; it has not been tested against your SAP system.

### Controlled SAP report creation

The **Testing Center** can create one new ABAP report from an **approved saved JDAP draft**. This is a real SAP write, so it is off by default and requires a separate create token plus an explicit per-request confirmation. The flow supports Z reports in `$TMP`: it creates the repository object, locks it, writes the approved source and unlocks it. Activation is a separate setting and authorization. SAP documents the ADT activation resource under `/sap/bc/adt/activation`; the activation handler in JDAP is provided as an opt-in integration and has not been verified against every SAP release or system configuration. Enable it only after validating the request and activation result in your S4D system.

Enable only when you are ready to perform that SAP write:
```env
SAP_ADT_ENABLE_OBJECT_CREATE=true
SAP_ADT_CREATE_API_TOKEN=use-a-different-long-random-token
SAP_ADT_ENABLE_OBJECT_ACTIVATION=false
SAP_ADT_ACTIVATE_API_TOKEN=use-another-different-long-random-token
```
Keep `SAP_ADT_ENABLE_SOURCE_READ` and its token independent. Recreate the backend after editing `.env`:
```powershell
docker compose up -d --force-recreate backend
```
In **Testing Center**, select an approved draft, enter a Z program name that exactly matches the source `REPORT`/`PROGRAM` statement, add a description, enter the create token, and type `CREATE IN SAP`. Choose `$TMP` for a local report, or load and choose a modifiable Workbench request and enter a transportable package to create a new report directly in that package/request. JDAP does not move existing objects. For drafts with selection labels, JDAP saves the approved labels to the SAP text pool and stops if the labels are not confirmed. To allow activation, separately set `SAP_ADT_ENABLE_OBJECT_ACTIVATION=true`, set a unique activation token, and recreate the backend. You can enable **Activate after save** for one approved create or activate a previously saved draft from the same panel. Each activation requires its separate token and the exact phrase `ACTIVATE IN SAP`. Before report activation, JDAP reads the SAP source and compares executable lines with the approved draft, verifies the selection labels, and runs SAP's native syntax check; an error or unconfirmed check stops report activation. The separate **Check active SAP syntax** action checks the active saved program. These checks are not ATC. JDAP does not release or import a transport.

This handler uses the ADT activation resource documented by SAP, but the activation payload and response behavior still require validation against the target S4D. A successful HTTP response alone is not definitive proof of active status; JDAP asks you to verify it in SAP. The activation routes are disabled by default. For the HTTP route, authentication and ABAP source are unencrypted in transit. Keep JDAP bound to a trusted developer machine/network.

This flow does not support package discovery/validation, automated ATC/DDIC validation, transport release/import, or rollback. Confirm the package is transportable and appropriate for the target system before creating the object.

## Optional ECC SAP Gateway OData check (read-only)

This independent business-API connection check does not use ADT. Configure a specific OData V2 service that your SAP Basis team confirms is active. The SAP administrator can register and activate supported services through transaction `/IWFND/MAINT_SERVICE`; which billing service exists depends on your ECC landscape and installed components. Do not assume an S/4HANA billing API name exists on ERP 6.0 EHP8. SAP documents service registration and ICF activation in its [Gateway service configuration guide](https://help.sap.com/docs/ABAP_PLATFORM_NEW/7259d88d2fab47bd808adcad3ca7ee9d/08b0a4f2c99f4051bbe170dc011cad42.html).

Add these values to `.env`, using the exact service root supplied by Basis (ending in `/sap/opu/odata/sap/<SERVICE_NAME>`):
```env
SAP_ODATA_SERVICE_URL=https://your-sap-host:port/sap/opu/odata/sap/YOUR_SERVICE_SRV
SAP_ODATA_ALLOW_HTTP=false
SAP_ODATA_CLIENT=200
SAP_ODATA_ENTITY_SET=DescMaterialSet
SAP_ODATA_USERNAME=your_read_only_user
SAP_ODATA_PASSWORD=your_password
SAP_ODATA_TIMEOUT_MS=8000
```

For your SAP HTTP service on port 8014, use the service root in `.env`, for example:
```env
SAP_ODATA_SERVICE_URL=http://103.89.45.155:8014/sap/opu/odata/sap/ZMATERIAL_DESC_SRV
SAP_ODATA_ALLOW_HTTP=true
SAP_ODATA_CLIENT=200
SAP_ODATA_ENTITY_SET=DescMaterialSet
```
HTTP Basic credentials and SAP business data are not encrypted in transit; use HTTP only on the network approved for this connection. Recreate the backend after changing `.env`. The **SAP Systems** page can **Discover service model** to list OData entity sets and property names/types from `$metadata`. Select a discovered entity set, then use **Check fields only** (discards values) or **Preview one live row** (shows the first row in the page without saving it). JDAP caps metadata at 1 MiB and sample responses at 256 KiB, retains only one row, and discards extras if SAP ignores `$top=1`.

To include one fresh SAP sample row in an AI Developer workflow, JDAP requires the metadata connection to be reachable and a non-mock AI provider. Enable **Include one live SAP OData sample row in agent context** for that task and confirm the disclosure. JDAP makes a new OData GET, passes only the first row directly to the architecture and ABAP agents, and records field names/transport in the workflow audit without separately storing the row. The sample is sent to the selected model endpoint (OpenAI or the configured Ollama endpoint); JDAP instructs agents to treat it as untrusted data and not repeat actual values. The generated workflow draft is persisted in JDAP and should still be reviewed for accidental disclosure. No SAP development repository is accessed or written.

## Reusing a saved JDAP draft as context

In **AI Developer**, the optional **Use an approved JDAP draft as context** selector lets you explicitly carry a prior approved requirement, report name, selection labels, and a bounded ABAP source excerpt into a new workflow. JDAP sends this selected context only to the architecture and ABAP agents through the configured model provider after a confirmation prompt. The current requirement takes precedence. Blocked quality-gate drafts are rejected as reference context. This does not import other ChatGPT conversations or read files from the user's Downloads folder; save/import those into JDAP first. JDAP stores a reference to the selected workflow in the new artifact and workflow record.

## Local development without Docker
The source also includes npm scripts for native development, but this ZIP's documented and recommended run path is Docker Compose.

## API
- `GET /api/health`
- `GET /api/agents`
- `GET /api/systems`
- `POST /api/workflows/execute` body: `{ "prompt": "...", "systemId": "mock-ecc" }`; returns a workflow ID immediately
- The workflow body may include `referenceWorkflowId` to use a prior approved JDAP draft as explicit, bounded context; the current prompt remains authoritative
- `POST /api/workflows/execute` may also include `{ "includeSapContext": true, "sapEntitySet": "DescMaterialSet" }` for a fresh live sample in an explicitly confirmed non-mock model workflow
- A focused Debug Center run adds `debugMode: true` to the workflow request so only the Debugging Specialist runs; any supplied ABAP source is diagnostic context and is not replaced
- `GET /api/workflows/:id` returns live agent statuses while the workflow runs and the saved artifact when complete
- `GET /api/artifacts/:id`
- `GET /api/code-studio/drafts` and `GET /api/code-studio/drafts/:id` list and read separately saved Code Studio sources
- `POST /api/code-studio/drafts` saves a new standalone ABAP source; `PUT /api/code-studio/drafts/:id` saves changes to that Code Studio draft. These drafts are separate from workflow artifacts and never write to SAP.
- `GET /api/approvals` lists local draft-review records
- `POST /api/approvals` body: `{ "artifactId": "...", "requestNote": "..." }`; creates a pending local review
- `POST /api/approvals/:id/prepare-selection-texts` creates a versioned review draft for a legacy approved billing report, keeps its ABAP source unchanged, adds JDAP-derived known labels, and requests a new approval
- `PATCH /api/approvals/:id` body: `{ "decision": "APPROVED" | "REJECTED", "reviewNote": "..." }`; records a local decision only
- `GET /api/approvals/:id/handoff` downloads a JSON developer handoff for an approved draft only and records the export in the audit log; it does not call SAP
- `GET /api/audit`
- `GET /api/sap/adt/connection` explicitly checks configured ADT discovery reachability; it does not retrieve source code
- `GET /api/sap/adt/programs/:name/source` reads one ABAP program when `SAP_ADT_ENABLE_SOURCE_READ=true` and a JDAP bearer token is configured
- `POST /api/sap/adt/programs/create` creates one approved report in `$TMP`, or in a specified transportable package with a modifiable Workbench request, as inactive when `SAP_ADT_ENABLE_OBJECT_CREATE=true`; requires a separate bearer token and `confirmation: "CREATE IN SAP"`. Transportable creation verifies the selected request in the CTS organizer and does not move existing objects.
- Create and activation save the approved `## Selection screen texts` section to the SAP text pool; activation stops if labels cannot be saved
- `POST /api/sap/adt/programs/activate` requests activation of one approved report only when `SAP_ADT_ENABLE_OBJECT_ACTIVATION=true`; requires a separate `X-JDAP-Activation-Token`, `confirmation: "ACTIVATE IN SAP"`, and a match of executable lines between saved SAP source and approved JDAP source
- `GET /api/sap/adt/transports` resolves the SAP user's saved CTS organizer search configuration, then reads its tree using `application/vnd.sap.adt.transportorganizertree.v1+xml`; requires the separate `SAP_ADT_READ_API_TOKEN` bearer token and performs no assignment, creation, release, or import
- `GET /api/sap/odata/connection` checks configured ECC Gateway OData V2 service metadata and reports HTTP/HTTPS transport
- `GET /api/sap/odata/metadata` discovers OData V2 entity-set names and property names/types; it reads metadata only
- `GET /api/sap/odata/read-check` explicitly requests `$top=1`, then reports the received count and field names only; SAP may return more if its service ignores the limit
- `GET /api/sap/odata/sample?entitySet=DescMaterialSet` explicitly reads a live sample and returns only the first row, bounded to a 256 KiB response; extra returned rows are discarded
- In a workflow request, `includeSapContext: true` reads the selected entity set; the first row is supplied to the configured model provider and its field names/transport are recorded, but the row itself is not separately stored by JDAP (generated agent output may include SAP values)
- `POST /api/abap/syntax-check` body: `{ "source": "...", "release": "v750" }`; performs an offline grammar check without contacting SAP

## Safety boundaries
- Mock ECC/S/4HANA/BTP profiles remain the development targets; optional direct SAP OData routes are read-only. A live OData row enters a non-mock model workflow only when the user enables it and confirms the disclosure.
- When the SAP OData URL uses HTTP, Basic credentials and returned business data are not encrypted in transit. Set `SAP_ODATA_ALLOW_HTTP=true` only on a network approved for that use. JDAP does not silently downgrade HTTPS to HTTP.
- Generated code is untrusted draft content.
- SAP report creation and activation are separate, disabled-by-default opt-ins. They require an approved saved draft, distinct tokens, and per-request confirmations. Creation can target `$TMP` or a specified transportable package and modifiable Workbench request; JDAP never releases or imports a transport.
- Testing Center runs offline ABAP grammar checks only; it does not perform SAP compiler checks, DDIC validation, ATC, ABAP Unit, transport operations, or deployment.
- For ABAP artifacts, JDAP applies an offline draft gate for parser errors, placeholders/assumptions, missing repository declarations, and `SELECT *`. It adds Clean Core review findings for direct SAP table dependencies and missing visible authorization controls. These are screening signals, not proof of Clean Core compliance.
- An ABAP approval must document SAP-side Clean Core evidence in its reviewer note: the target system's ATC result, released API/release-contract evidence, or extension-point evidence. JDAP checks that evidence is recorded before SAP create/activation, but does not independently validate the evidence.
- JDAP does not assign a Clean Core Level. Confirm the ABAP language version, API release contracts, extension model, and applicable Clean Core ATC variant in the actual S/4HANA target system. Until ATC integration is implemented, report the JDAP Clean Core state as **SAP ATC required / not classified**.
- Production use requires identity integration, tenant isolation, secret management, threat modeling, data-retention controls, and live SAP integration testing.
- The Git & Transports screen reads CTS request metadata. Testing Center can create a new approved report directly into a chosen transportable package and modifiable Workbench request. JDAP does not move existing objects, create transport requests, release requests, or import transports.


## Knowledge Hub
- rontend/src/pages/KnowledgeHub.jsx: local search and reader for JDAP guidance.
- ackend/src/knowledge: Markdown reader and /api/knowledge endpoints.
- knowledge-base/{abap,cds,rap,odata,sap-standards}: starter working guides. These are local reference notes, not a Clean Core certification or external SAP documentation index.


## MCP tools

JDAP provides an optional local stdio MCP server with two read-only tools: `search_approved_jdap_guidance` and `read_approved_jdap_guide`. They only return local Knowledge Hub documents marked `workflowApproved: true`, enforce excerpt/document size limits, and include source attribution. The process does not expose HTTP or provide SAP, approval, GitHub, CTS, activation, or other write operations.

To connect a local MCP host while the JDAP backend container is running, configure it to launch `docker` with arguments `compose exec -T backend node /app/src/mcp/server.js`, using the JDAP project directory containing `docker-compose.yml` as its working directory. See `backend/src/mcp/README.md`.

Set-Location "$env:USERPROFILE\Desktop"
git clone https://github.com/btpsapabap-gif/JDAP-Final.git
Set-Location .\JDAP-Final

'AI_PROVIDER=mock' | Set-Content -LiteralPath '.env' -Encoding ascii

docker compose up --build -d
docker compose ps
docker compose logs --tail 50 backend
Invoke-RestMethod 'http://localhost:4001/api/health' | Format-List
