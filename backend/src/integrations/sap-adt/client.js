import { randomUUID } from "node:crypto";

const DISCOVERY_PATH = "/sap/bc/adt/discovery";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_CREATE_SOURCE_BYTES = 200_000;

function readConfig(env = process.env) {
  const baseUrl = (env.SAP_ADT_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl) return { configured: false };
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error("SAP_ADT_BASE_URL must be a valid absolute URL"); }
  const httpAllowed = env.SAP_ADT_ALLOW_HTTP === "true";
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && httpAllowed)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SAP_ADT_BASE_URL must use HTTPS, or HTTP with SAP_ADT_ALLOW_HTTP=true, and must not contain embedded credentials, query, or fragment");
  }
  return {
    configured: true,
    baseUrl,
    username: env.SAP_ADT_USERNAME || env.SAP_ODATA_USERNAME || "",
    password: env.SAP_ADT_PASSWORD || env.SAP_ODATA_PASSWORD || "",
    client: env.SAP_ADT_CLIENT || env.SAP_ODATA_CLIENT || "",
    timeoutMs: Math.max(1000, Math.min(Number(env.SAP_ADT_TIMEOUT_MS) || 8000, 30000))
  };
}

/** Performs an explicit, read-only ADT discovery request. It never writes SAP data. */
export async function checkSapAdtConnection(env = process.env, fetchImpl = fetch) {
  const config = readConfig(env);
  if (!config.configured) return { configured: false, state: "not-configured", message: "SAP ADT is not configured; JDAP remains in mock SAP mode." };
  const transport = new URL(config.baseUrl).protocol.slice(0, -1).toUpperCase();
  if (!config.username || !config.password) return { configured: true, state: "missing-credentials", transport, message: "SAP ADT URL is configured, but username/password are missing." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: "application/atomsvc+xml, application/xml, text/xml",
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
  };
  if (config.client) headers["sap-client"] = config.client;
  try {
    const response = await fetchImpl(`${config.baseUrl}${DISCOVERY_PATH}`, {
      method: "GET", headers, signal: controller.signal, redirect: "manual"
    });
    if (response.status >= 200 && response.status < 300) {
      return { configured: true, state: "reachable", transport, httpStatus: response.status, checkedAt: new Date().toISOString(), message: "SAP ADT discovery endpoint responded. This confirms endpoint reachability only." };
    }
    const state = response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "adt-not-found" : "http-error";
    return { configured: true, state, transport, httpStatus: response.status, checkedAt: new Date().toISOString(), message: `SAP ADT discovery returned HTTP ${response.status}.` };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { configured: true, state: timeout ? "timeout" : "unreachable", transport, checkedAt: new Date().toISOString(), message: timeout ? "SAP ADT request timed out." : "Could not reach SAP ADT. Check the configured HTTP/HTTPS route, network, and SAP ICF service." };
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedText(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_SOURCE_BYTES) throw new Error("SAP source response exceeded the 1 MiB limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new Error("SAP source response exceeded the 1 MiB limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Reads the main source of one ABAP program. This function only issues GET requests. */
export async function readAbapProgramSource(programName, env = process.env, fetchImpl = fetch, version = "active") {
  const config = readConfig(env);
  if (!config.configured) return { ok: false, status: 409, state: "not-configured", message: "SAP ADT is not configured." };
  if (!config.username || !config.password) return { ok: false, status: 409, state: "missing-credentials", message: "SAP ADT credentials are not configured." };
  const normalizedName = String(programName || "").trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,40}$/.test(normalizedName)) return { ok: false, status: 400, state: "invalid-program-name", message: "Use an ABAP program name containing only A-Z, 0-9, and underscore (1–40 characters)." };
  const sourceVersion = String(version || "active").toLowerCase();
  if (sourceVersion !== "active" && sourceVersion !== "inactive") return { ok: false, status: 400, state: "invalid-version", message: "Source version must be active or inactive." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: "text/plain",
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
  };
  if (config.client) headers["sap-client"] = config.client;
  const sourcePath = `/sap/bc/adt/programs/programs/${encodeURIComponent(normalizedName.toLowerCase())}/source/main${sourceVersion === "inactive" ? "?version=inactive" : ""}`;
  try {
    const response = await fetchImpl(`${config.baseUrl}${sourcePath}`, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    if (!response.ok) {
      const detail = (await readLimitedText(response)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
      const status = response.status === 401 || response.status === 403 ? 403 : response.status === 404 ? 404 : 502;
      return { ok: false, status, state: response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "program-not-found" : "sap-http-error", message: `SAP ADT ${sourceVersion} source request returned HTTP ${response.status}.${detail ? ` ${detail}` : ""}` };
    }
    const source = await readLimitedText(response);
    return { ok: true, programName: normalizedName, source, version: sourceVersion, transport: new URL(config.baseUrl).protocol.slice(0, -1).toUpperCase(), retrievedAt: new Date().toISOString(), note: "Read from SAP ADT. JDAP made no SAP changes." };
  } catch (error) {
    const tooLarge = /exceeded the 1 MiB limit/.test(error?.message || "");
    const timeout = error?.name === "AbortError";
    return { ok: false, status: tooLarge ? 413 : 502, state: tooLarge ? "source-too-large" : timeout ? "timeout" : "unreachable", message: tooLarge ? error.message : timeout ? "SAP ADT request timed out." : "Could not retrieve source from SAP ADT. Check the configured HTTP/HTTPS route, network, and SAP authorizations." };
  } finally { clearTimeout(timer); }
}

/** Reads CTS request metadata through the ADT transport organizer resource. */
export async function listSapTransportRequests(env = process.env, fetchImpl = fetch) {
  const config = readConfig(env);
  if (!config.configured) return { ok: false, status: 409, state: "not-configured", message: "SAP ADT is not configured." };
  if (!config.username || !config.password) return { ok: false, status: 409, state: "missing-credentials", message: "SAP ADT credentials are not configured." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: "application/vnd.sap.adt.transportorganizertree.v1+xml",
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
  };
  if (config.client) headers["sap-client"] = config.client;
  const configsPath = "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations";
  const attr = (attributes, key) => attributes.match(new RegExp(`(?:[\\w.-]+:)?${key}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "";
  const decode = value => String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  try {
    const getXml = async (path, accept) => {
      let response = await fetchImpl(`${config.baseUrl}${path}`, { method: "GET", headers: { ...headers, Accept: accept }, signal: controller.signal, redirect: "manual" });
      let body = (await response.text()).slice(0, 200_000);
      if (response.status === 406) {
        const mediaType = body.match(/Accepted content types:\s*([^\s<]+)/i)?.[1];
        if (mediaType) {
          response = await fetchImpl(`${config.baseUrl}${path}`, { method: "GET", headers: { ...headers, Accept: mediaType }, signal: controller.signal, redirect: "manual" });
          body = (await response.text()).slice(0, 200_000);
        }
      }
      return { response, body };
    };

    // The ADT collection returns only an empty root unless it is called with
    // the URI of a saved organizer search configuration. Resolve the user's
    // Workbench/Modifiable search configuration before reading the tree.
    const configList = await getXml(configsPath, "application/xml, text/xml");
    if (!configList.response.ok) {
      return { ok: false, status: configList.response.status === 401 || configList.response.status === 403 ? 403 : 502, state: "transport-search-configuration-unavailable", httpStatus: configList.response.status, message: `SAP ADT could not return transport search configurations (HTTP ${configList.response.status}). No transport changes were performed.` };
    }
    const configNodes = [...configList.body.matchAll(/<([\w.-]+)\b([^>]*)>/gi)].filter(([, , attributes]) => /(?:href|uri)\s*=/i.test(attributes));
    const configUris = [...new Set(configNodes.flatMap(([, , attributes]) => {
      const uri = decode(attr(attributes, "uri") || attr(attributes, "href") || attr(attributes, "adtcore:uri") || attr(attributes, "xlink:href") || "");
      if (!uri) return [];
      try {
        const parsed = new URL(uri, config.baseUrl);
        return parsed.origin === new URL(config.baseUrl).origin && parsed.pathname.startsWith(configsPath + "/") ? [parsed.pathname + parsed.search] : [];
      } catch { return []; }
    }))].slice(0, 25);
    if (!configUris.length) return { ok: false, status: 502, state: "transport-search-configuration-missing", httpStatus: configList.response.status, contentType: configList.response.headers.get("content-type") || "", message: "SAP ADT returned no saved transport organizer search configuration. Its collection response contained no configuration links; JDAP did not change SAP." };

    const candidates = [];
    for (const uri of configUris) {
      const item = await getXml(uri, "application/xml, text/xml");
      if (!item.response.ok) continue;
      const text = item.body.toLowerCase();
      const name = uri.split("/").pop() || uri;
      const userMatch = text.includes(config.username.toLowerCase()) || name.toLowerCase().includes(config.username.toLowerCase());
      const score = (userMatch ? 8 : 0) + (/workbench/.test(text) ? 3 : 0) + (/modifiable|status[^\n>]*\bd\b/.test(text) ? 3 : 0);
      candidates.push({ uri, body: item.body, score });
    }
    if (!candidates.length) return { ok: false, status: 502, state: "transport-search-configuration-unreadable", message: "SAP ADT listed transport organizer configurations, but JDAP could not read their saved definitions. No transport changes were performed." };
    candidates.sort((a, b) => b.score - a.score);
    const selectedConfig = candidates[0];
    const treePath = "/sap/bc/adt/cts/transportrequests?configUri=" + encodeURIComponent(selectedConfig.uri);
    const { response, body } = await getXml(treePath, "application/vnd.sap.adt.transportorganizertree.v1+xml");
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? 403 : response.status === 404 ? 404 : 502;
      const state = response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "cts-resource-not-found" : "sap-http-error";
      return { ok: false, status, state, httpStatus: response.status, message: `SAP ADT CTS request listing returned HTTP ${response.status}: ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 700)}` };
    }
    if (!body.trim() || !/^\s*</.test(body) || !/<(?:[\w.-]+:)?(?:transportOrganizerTree|root)\b/i.test(body)) return { ok: false, status: 502, state: "cts-response-unrecognized", httpStatus: response.status, contentType: response.headers.get("content-type") || "", message: "SAP returned HTTP 200, but JDAP could not confirm a transport organizer tree response. No transport action was performed." };
    const elements = [...body.matchAll(/<(?:[\w.-]+:)?(?:transportRequest|request|transport|item|node|entry)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?(?:transportRequest|request|transport|item|node|entry)\s*>)/gi)];
    const readChild = (xml, names) => {
      for (const name of names) {
        const match = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, "i"));
        if (match) return decode(match[1].replace(/<[^>]+>/g, "").trim());
      }
      return "";
    };
    const requests = elements.slice(0, 200).map(match => {
      const [, attributes, inner = ""] = match;
      const ancestorText = body.slice(0, match.index).toLowerCase();
      const typeMatches = [...ancestorText.matchAll(/<(?:[\w.-]+:)?(workbench|customizing)\b/gi)];
      const statusMatches = [...ancestorText.matchAll(/<(?:[\w.-]+:)?(modifiable|released)\b/gi)];
      return {
        id: attr(attributes, "number") || attr(attributes, "id") || attr(attributes, "trkorr") || attr(attributes, "name") || attr(attributes, "requestNumber") || attr(attributes, "request") || attr(attributes, "uri").match(/([A-Z0-9]{3,20}K\d{6})(?:$|[?#])/i)?.[1]?.toUpperCase() || readChild(inner, ["number", "id", "trkorr", "requestNumber", "name"]),
        description: attr(attributes, "description") || attr(attributes, "desc") || readChild(inner, ["description", "desc", "as4text", "shortDescription"]),
        owner: attr(attributes, "owner") || readChild(inner, ["owner", "as4user", "user"]),
        status: attr(attributes, "status") || readChild(inner, ["status", "requestStatus"]) || (statusMatches.at(-1)?.[1] === "modifiable" ? "Modifiable" : statusMatches.at(-1)?.[1] === "released" ? "Released" : ""),
        type: attr(attributes, "type") || readChild(inner, ["type", "requestType"]) || (typeMatches.at(-1)?.[1] === "workbench" ? "Workbench" : typeMatches.at(-1)?.[1] === "customizing" ? "Customizing" : ""),
        uri: attr(attributes, "uri")
      };
    }).filter(item => /^[A-Z0-9]{3,20}(?:K\d{6})?$/.test(item.id));
    return { ok: true, state: "transport-requests-read", httpStatus: response.status, transport: new URL(config.baseUrl).protocol.slice(0, -1).toUpperCase(), requests, checkedAt: new Date().toISOString(), message: `SAP ADT returned ${requests.length} transport request(s). JDAP did not assign objects or change transport status.`, note: "Only request metadata is shown. Selection, object assignment, release, and import are not performed." };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { ok: false, status: timeout ? 504 : 502, state: timeout ? "timeout" : "unreachable", message: timeout ? "SAP ADT transport request listing timed out." : "Could not read SAP transport requests through ADT. Check the network route and SAP authorizations." };
  } finally { clearTimeout(timer); }
}

function xmlDecode(value = "") {
  return String(value).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function parseCheckRunMessages(xml = "") {
  const attr = (attributes, name) => attributes.match(new RegExp("(?:[\\w.-]+:)?" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"))?.[1] || "";
  const blocks = [...String(xml).matchAll(/<(?:[\w.-]+:)?checkMessage\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?checkMessage\s*>)/gi)];
  return blocks.slice(0, 100).map(([, attributes, body = ""]) => {
    const rawSeverity = attr(attributes, "type") || attr(attributes, "severity") || "I";
    const uri = attr(attributes, "uri");
    const position = uri.match(/#(?:start|line)=(\d+)(?:,(\d+))?/i);
    const message = xmlDecode(attr(attributes, "shortText") || body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    return { severity: ({ E: "error", F: "fatal", W: "warning", I: "info" })[rawSeverity.toUpperCase()] || rawSeverity, line: Number(position?.[1] || attr(attributes, "line") || 0) || null, column: Number(position?.[2] || attr(attributes, "column") || 0) || null, code: attr(attributes, "code") || "", message };
  }).filter(item => item.message);
}

/** Runs SAP's native syntax check on the active or inactive version of one existing program. */
export async function checkAbapProgramSyntax(programName, env = process.env, fetchImpl = fetch, version = "active") {
  const config = readConfig(env);
  const name = String(programName || "").trim().toUpperCase();
  if (!config.configured) return { ok: false, status: 409, state: "not-configured", message: "SAP ADT is not configured." };
  if (!config.username || !config.password) return { ok: false, status: 409, state: "missing-credentials", message: "SAP ADT credentials are not configured." };
  if (!/^[A-Z0-9_]{1,40}$/.test(name)) return { ok: false, status: 400, state: "invalid-program-name", message: "Enter a valid ABAP program name (A-Z, 0-9, underscore)." };
  if (version !== "active" && version !== "inactive") return { ok: false, status: 400, state: "invalid-version", message: "Syntax check version must be active or inactive." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const common = { Authorization: "Basic " + Buffer.from(config.username + ":" + config.password).toString("base64"), "x-sap-adt-sessiontype": "stateful", "sap-adt-connection-id": randomUUID(), "sap-contextid-accept": "header" };
  if (config.client) common["sap-client"] = config.client;
  let cookie = "", contextId = "", csrf = "";
  const call = async (path, options = {}) => {
    const response = await fetchImpl(config.baseUrl + path, { ...options, signal: controller.signal, redirect: "manual", headers: { ...common, "sap-adt-request-id": randomUUID(), ...(cookie ? { Cookie: cookie } : {}), ...(contextId ? { "sap-contextid": contextId } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(options.headers || {}) } });
    cookie = mergeCookieHeaders(cookie, response);
    const returnedContextId = response.headers.get("sap-contextid");
    if (returnedContextId !== null) contextId = returnedContextId.trim() && returnedContextId.trim() !== "0" ? returnedContextId.trim() : "";
    return response;
  };
  try {
    let tokenResponse = await call("/sap/bc/adt/core/http/sessions", { method: "GET", headers: { "x-csrf-token": "Fetch", Accept: "application/vnd.sap.adt.core.http.session.v3+xml, application/xml" } });
    csrf = tokenResponse.headers.get("x-csrf-token") || "";
    await tokenResponse.body?.cancel();
    if (!csrf) {
      tokenResponse = await call(DISCOVERY_PATH, { method: "GET", headers: { "x-csrf-token": "Fetch", Accept: "application/atomsvc+xml, application/xml, text/xml" } });
      csrf = tokenResponse.headers.get("x-csrf-token") || "";
      await tokenResponse.body?.cancel();
    }
    if (!csrf || /^(required|fetch)$/i.test(csrf.trim())) return { ok: false, status: 502, state: "csrf-unavailable", message: "SAP ADT did not provide a CSRF token for the native syntax check." };
    const objectUri = "/sap/bc/adt/programs/programs/" + name.toLowerCase();
    const body = '<?xml version="1.0" encoding="UTF-8"?><chkrun:checkObjectList xmlns:adtcore="http://www.sap.com/adt/core" xmlns:chkrun="http://www.sap.com/adt/checkrun"><chkrun:checkObject adtcore:uri="' + objectUri + '" chkrun:version="' + version + '"/></chkrun:checkObjectList>';
    const response = await call("/sap/bc/adt/checkruns?reporters=abapCheckRun", { method: "POST", body, headers: { "Content-Type": "application/vnd.sap.adt.checkobjects+xml; charset=utf-8", Accept: "application/vnd.sap.adt.checkmessages+xml" } });
    const responseText = (await response.text()).slice(0, 200_000);
    if (!response.ok) return { ok: false, status: response.status === 401 || response.status === 403 ? 403 : 502, state: "sap-check-rejected", httpStatus: response.status, message: "SAP native syntax check returned HTTP " + response.status + ": " + responseText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000) };
    if (!/<(?:[\w.-]+:)?checkRunReports\b/i.test(responseText) || !/<(?:[\w.-]+:)?checkReport\b/i.test(responseText)) return { ok: false, status: 502, state: "sap-check-unconfirmed", httpStatus: response.status, message: "SAP returned HTTP 200, but JDAP could not confirm that a syntax check report was produced. No syntax-clean result is claimed." };
    const messages = parseCheckRunMessages(responseText);
    const errors = messages.filter(item => /error|fatal/i.test(item.severity));
    return { ok: true, state: errors.length ? "sap-syntax-errors" : "sap-syntax-ok", programName: name, version, httpStatus: response.status, message: errors.length ? "SAP syntax check found " + errors.length + " error(s) in the " + version + " version of " + name + "." : "SAP syntax check completed for the " + version + " version of " + name + "; no error-severity findings were returned.", messages, checkedAt: new Date().toISOString(), note: "This checks the saved SAP version requested. It does not check unsaved editor text, activate objects, or run ATC." };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { ok: false, status: timeout ? 504 : 502, state: timeout ? "timeout" : "unreachable", message: timeout ? "SAP native syntax check timed out." : "SAP native syntax check failed: " + error.message };
  } finally { clearTimeout(timer); }
}

function isTargetListedInactive(xml, name, type) {
  const wanted = name.toUpperCase();
  const wantedTypes = type === "REPT" ? new Set(["REPT", "PROG/PX"]) : new Set([type]);
  const refs = [...String(xml || "").matchAll(/<(?:[\w.-]+:)?(?:objectReference|ref)\b([^>]*)>/gi)];
  for (const [, attributes] of refs) {
    const readAttr = key => attributes.match(new RegExp(`(?:[\\w.-]+:)?${key}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "";
    if (readAttr("name").toUpperCase() === wanted && wantedTypes.has(readAttr("type").toUpperCase())) return true;
  }
  return false;
}

function inactiveTextPoolReferences(xml, name) {
  const wanted = name.toUpperCase();
  const refs = [...String(xml || "").matchAll(/<(?:[\w.-]+:)?(?:objectReference|ref)\b([^>]*)>/gi)];
  return refs.flatMap(([, attributes]) => {
    const readAttr = key => attributes.match(new RegExp(`(?:[\\w.-]+:)?${key}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "";
    const ref = {
      name: readAttr("name"), type: readAttr("type"), uri: readAttr("uri"), parentUri: readAttr("parentUri")
    };
    return ref.name.toUpperCase() === wanted && new Set(["REPT", "PROG/PX"]).has(ref.type.toUpperCase()) && ref.uri
      ? [ref]
      : [];
  });
}

async function requestAndVerifyActivation({ programName, type, uri }, config, fetchImpl = fetch) {
  const name = String(programName || "").trim().toUpperCase();
  const common = {
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
    Accept: "application/vnd.sap.adt.activation+xml, application/xml, text/xml",
    "x-sap-adt-sessiontype": "stateful",
    "sap-adt-connection-id": randomUUID(),
    "sap-contextid-accept": "header"
  };
  if (config.client) common["sap-client"] = config.client;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let cookie = "";
  let csrf = "";
  let sapContextId = "";
  let securitySessionMode = "create";
  const call = async (path, options = {}) => {
    const response = await fetchImpl(`${config.baseUrl}${path}`, { ...options, signal: controller.signal, redirect: "manual", headers: { ...common, "x-sap-security-session": securitySessionMode, "sap-adt-request-id": randomUUID(), ...(cookie ? { Cookie: cookie } : {}), ...(sapContextId ? { "sap-contextid": sapContextId } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(options.headers || {}) } });
    cookie = mergeCookieHeaders(cookie, response);
    const returnedContextId = response.headers.get("sap-contextid");
    if (returnedContextId !== null) sapContextId = returnedContextId.trim() && returnedContextId.trim() !== "0" ? returnedContextId.trim() : "";
    return response;
  };
  try {
    let tokenResponse = await call("/sap/bc/adt/core/http/sessions", { method: "GET", headers: { "x-csrf-token": "Fetch", Accept: "application/vnd.sap.adt.core.http.session.v3+xml, application/xml" } });
    csrf = tokenResponse.headers.get("x-csrf-token") || "";
    await tokenResponse.body?.cancel();
    if (!csrf) {
      tokenResponse = await call(DISCOVERY_PATH, { method: "GET", headers: { "x-csrf-token": "Fetch", Accept: "application/atomsvc+xml, application/xml, text/xml" } });
      csrf = tokenResponse.headers.get("x-csrf-token") || "";
      await tokenResponse.body?.cancel();
    }
    if (!csrf || /^(required|fetch)$/i.test(csrf.trim())) return { ok: false, status: 502, state: "csrf-unavailable", message: `SAP ADT did not return a CSRF token; ${type === "REPT" ? "selection texts" : "the report"} were not activated.` };
    securitySessionMode = "use";
    const body = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:name="${name}" adtcore:uri="${uri}" adtcore:type="${type}"/></adtcore:objectReferences>`;
    const response = await call("/sap/bc/adt/activation?method=activate&preauditRequested=false", { method: "POST", body, headers: { "Content-Type": "application/vnd.sap.adt.activation+xml; charset=utf-8", Accept: "application/vnd.sap.adt.activation+xml, application/xml, text/xml" } });
    const responseText = (await response.text()).slice(0, 6000);
    const subject = type === "REPT" ? "selection text pool" : "report";
    if (!response.ok) return { ok: false, status: 502, state: "activation-rejected", httpStatus: response.status, programName: name, message: `SAP ADT ${subject} activation returned HTTP ${response.status}: ${responseText.slice(0, 1200)}` };
    if (/<(?:\w+:)?message\b[^>]*(?:severity=["'](?:error|fatal)|type=["'](?:error|fatal))/i.test(responseText) || /<(?:(?:\w+):)?error\b/i.test(responseText)) {
      return { ok: false, status: 502, state: "activation-errors", httpStatus: response.status, programName: name, message: `SAP ADT returned activation diagnostics for the ${subject}; review SAP response before retrying: ${responseText.slice(0, 1200)}` };
    }
    const inactiveResponse = await call("/sap/bc/adt/activation/inactiveobjects", { method: "GET", headers: { Accept: "application/vnd.sap.adt.inactiveobjects+xml, application/xml, text/xml" } });
    if (!inactiveResponse.ok) {
      await inactiveResponse.body?.cancel();
      return { ok: false, status: 502, state: "activation-unconfirmed", httpStatus: response.status, programName: name, message: `SAP accepted the ${subject} activation request, but JDAP could not verify its status. Check the report/text-pool status in SAP before trying again.` };
    }
    const inactiveXml = await inactiveResponse.text();
    // Some supported SAP releases answer a successful inactive-object query
    // with HTTP 200 and no entity when the current user's inactive list is
    // empty. Treat that as an empty list; do not mistake it for malformed XML.
    if (!inactiveXml.trim()) return { ok: true, state: "activated", programName: name, objectType: type, httpStatus: response.status, message: `SAP returned an empty inactive-object list; the ${subject} for ${name} is not listed as inactive.` };
    if (!/<(?:[\w.-]+:)?(?:inactiveObjects|objectReferences)\b/i.test(inactiveXml)) return { ok: false, status: 502, state: "activation-unconfirmed", httpStatus: response.status, programName: name, message: `SAP accepted the ${subject} activation request, but JDAP could not interpret SAP's inactive-object status response. Check the status in SAP before trying again.` };
    if (isTargetListedInactive(inactiveXml, name, type)) return { ok: false, status: 502, state: "activation-still-inactive", httpStatus: response.status, programName: name, message: `SAP still lists the ${subject} for ${name} as inactive. JDAP did not treat activation as successful.` };
    return { ok: true, state: "activated", programName: name, objectType: type, httpStatus: response.status, message: `SAP reports the ${subject} for ${name} is no longer inactive.` };
  } catch (error) {
    return { ok: false, status: error?.name === "AbortError" ? 504 : 502, state: error?.name === "AbortError" ? "timeout" : "activation-failed", programName: name, message: error?.name === "AbortError" ? `SAP ADT activation timed out; check the ${type === "REPT" ? "text-pool" : "report"} status before retrying.` : `SAP ADT activation failed: ${error.message}` };
  } finally { clearTimeout(timer); }
}

/** Activates exactly one approved Z report through ADT and verifies it is no longer inactive. */
export async function activateAbapProgram({ programName, source }, env = process.env, fetchImpl = fetch) {
  const config = readConfig(env);
  const name = String(programName || "").trim().toUpperCase();
  if (!config.configured) return { ok: false, status: 409, state: "not-configured", message: "SAP ADT is not configured." };
  if (!config.username || !config.password) return { ok: false, status: 409, state: "missing-credentials", message: "SAP ADT credentials are not configured." };
  if (!/^Z[A-Z0-9_]{1,39}$/.test(name)) return { ok: false, status: 400, state: "invalid-program-name", message: "Activation is limited to a Z program name." };
  if (typeof source !== "string" || !source.trim()) return { ok: false, status: 400, state: "invalid-source", message: "The approved ABAP source is missing." };
  const declaration = source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z0-9_]+)/im)?.[1]?.toUpperCase();
  if (declaration !== name) return { ok: false, status: 409, state: "program-name-mismatch", message: "The approved source declaration does not match the requested program." };
  return requestAndVerifyActivation({ programName: name, type: "PROG/P", uri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}` }, config, fetchImpl);
}

/** Writes approved selection labels to the ADT text-elements resource and requires an exact read-back. */
export async function writeAbapSelectionTexts({ programName, entries, activate = false, transportRequest = "" }, env = process.env, fetchImpl = fetch) {
  const config = readConfig(env);
  const name = String(programName || "").trim().toUpperCase();
  if (!config.configured) return { ok: false, status: 409, state: "not-configured", message: "SAP ADT is not configured." };
  if (!config.username || !config.password) return { ok: false, status: 409, state: "missing-credentials", message: "SAP ADT credentials are not configured." };
  if (!/^Z[A-Z0-9_]{1,39}$/.test(name)) return { ok: false, status: 400, state: "invalid-program-name", message: "Selection text updates are limited to a Z program name." };
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 40) return { ok: false, status: 400, state: "selection-texts-missing", message: "The approved JDAP artifact has no selection texts to send." };
  for (const item of entries) {
    if (!/^[A-Z0-9_]{1,8}$/.test(item?.name || "") || typeof item?.text !== "string" || !item.text.trim() || item.text.length > 30 || /[\r\n=]/.test(item.text)) {
      return { ok: false, status: 422, state: "invalid-selection-texts", message: "Selection text keys must be valid ABAP parameter names and each label must be 1–30 characters." };
    }
  }
  const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  const language = String(env.SAP_ADT_LANGUAGE || "EN").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(language)) return { ok: false, status: 400, state: "invalid-language", message: "SAP_ADT_LANGUAGE must be a two-letter language code, such as EN." };
  const common = { Authorization: auth, "x-sap-adt-sessiontype": "stateful", "sap-adt-connection-id": randomUUID(), "sap-contextid-accept": "header", "sap-language": language };
  if (config.client) common["sap-client"] = config.client;
  const base = config.baseUrl;
  const textUri = `/sap/bc/adt/textelements/programs/${name.toLowerCase()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let cookie = "";
  let csrf = "";
  let contextId = "";
  let lockHandle = "";
  let securitySession = "create";
  const call = async (path, options = {}) => {
    const headers = { ...common, "sap-adt-request-id": randomUUID(), "x-sap-security-session": securitySession,
      ...(cookie ? { Cookie: cookie } : {}), ...(contextId ? { "sap-contextid": contextId } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(options.headers || {}) };
    const response = await fetchImpl(`${base}${path}`, { ...options, signal: controller.signal, redirect: "manual", headers });
    cookie = mergeCookieHeaders(cookie, response);
    const returnedContextId = response.headers.get("sap-contextid");
    if (returnedContextId !== null) contextId = returnedContextId.trim() && returnedContextId.trim() !== "0" ? returnedContextId.trim() : "";
    return response;
  };
  const fail = async (response, action) => {
    const rawDetail = (await response.text()).slice(0, 10000);
    const isHtml = /text\/html/i.test(response.headers.get("content-type") || "") || /<html\b/i.test(rawDetail);
    const detail = isHtml
      ? (rawDetail.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || rawDetail.match(/class=["'][^"']*errorTextHeader[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || "SAP returned an HTML service error page")
        .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().slice(0, 240)
      : rawDetail.slice(0, 1000);
    const missing = response.status === 404 ? " SAP does not expose the ADT text-elements resource on this system." : "";
    return { ok: false, status: 502, state: response.status === 404 ? "text-elements-unavailable" : "selection-text-save-failed", httpStatus: response.status, responseType: isHtml ? "html-error-page" : "adt-response", message: `SAP selection text ${action} returned HTTP ${response.status}.${missing}${detail ? ` ${isHtml ? " SAP says: " : " "}${detail}` : ""}` };
  };
  try {
    let response = await call("/sap/bc/adt/core/http/sessions", { method: "GET", headers: { "x-csrf-token": "Fetch", Accept: "application/vnd.sap.adt.core.http.session.v3+xml, application/xml" } });
    csrf = response.headers.get("x-csrf-token") || "";
    await response.body?.cancel();
    if (!csrf) {
      response = await call(DISCOVERY_PATH, { method: "GET", headers: { "x-csrf-token": "Fetch", Accept: "application/atomsvc+xml, application/xml, text/xml" } });
      csrf = response.headers.get("x-csrf-token") || "";
      await response.body?.cancel();
    }
    if (!csrf || /^(required|fetch)$/i.test(csrf.trim())) return { ok: false, status: 502, state: "csrf-unavailable", message: "SAP ADT did not return a CSRF token; selection texts were not sent." };
    securitySession = "use";
    response = await call(textUri, { method: "GET", headers: { Accept: "application/vnd.sap.adt.textelements.v1+xml" } });
    if (!response.ok) return await fail(response, "resource check");
    await response.body?.cancel();
    // Text-element source updates use SAP's resource ETag as a write
    // precondition. Without If-Match some SAP releases acknowledge the PUT
    // but leave the text pool unchanged.
    response = await call(`${textUri}/source/selections`, { method: "GET", headers: { Accept: "application/vnd.sap.adt.textelements.selections.v1" } });
    if (!response.ok) return await fail(response, "selection source check");
    const selectionEtag = response.headers.get("etag") || "";
    await response.body?.cancel();
    // Selection text source is a locked ADT resource. A direct PUT may return
    // "Parameter lockHandle could not be found" even when it returns HTTP 200
    // on some SAP releases, so obtain a handle and send it with the PUT. For
    // transportable objects, bind the selected Workbench request at lock time
    // as well as on the subsequent write; SAP derives the change context from
    // the lock session.
    const lockQuery = new URLSearchParams({ _action: "LOCK", accessMode: "MODIFY" });
    if (transportRequest) lockQuery.set("corrNr", transportRequest);
    response = await call(`${textUri}?${lockQuery.toString()}`, { method: "POST", body: "", headers: { Accept: "application/vnd.sap.as+xml" } });
    if (!response.ok) return await fail(response, "lock");
    const lockXml = await response.text();
    lockHandle = lockXml.match(/<(?:\w+:)?LOCK_HANDLE>([^<]+)<\/(?:\w+:)?LOCK_HANDLE>/i)?.[1] || lockXml.match(/lockHandle="([^"]+)"/i)?.[1] || "";
    if (!lockHandle) return { ok: false, status: 502, state: "selection-text-lock-missing", message: "SAP did not return a text-pool lock handle; selection labels were not written." };
    // ADT's source/selections contract is one unpadded PARAM=text row per
    // field. The fixed-width eight-character flags belong to the internal
    // text-pool representation, not this HTTP source format.
    const body = entries.map(({ name: key, text }) => `${key.toUpperCase()}=${text.trim()}`).join("\n");
    const putQuery = new URLSearchParams({ lockHandle });
    if (transportRequest) putQuery.set("corrNr", transportRequest);
    const selectionWriteUri = `${textUri}/source/selections?${putQuery.toString()}`;
    response = await call(selectionWriteUri, { method: "PUT", body, headers: { "Content-Type": "application/vnd.sap.adt.textelements.selections.v1", Accept: "application/vnd.sap.adt.textelements.selections.v1", ...(selectionEtag ? { "If-Match": selectionEtag } : {}) } });
    const saveHttpStatus = response.status;
    const saveContentType = response.headers.get("content-type") || "";
    const saveEtag = response.headers.get("etag") || "";
    const saveResponseBody = (await response.text()).slice(0, 1200);
    if (!response.ok) return { ok: false, status: 502, state: "selection-text-save-failed", httpStatus: saveHttpStatus, contentType: saveContentType, sapResponse: saveResponseBody, message: `SAP selection text save returned HTTP ${saveHttpStatus}.${saveResponseBody ? ` ${saveResponseBody}` : ""}` };
    const unlock = await call(`${textUri}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, { method: "POST", body: "", headers: { Accept: "application/vnd.sap.as+xml" } });
    if (!unlock.ok) return await fail(unlock, "unlock");
    lockHandle = "";
    await unlock.body?.cancel();

    let activationHttpStatus = null;
    if (activate) {
      const inactiveBefore = await call("/sap/bc/adt/activation/inactiveobjects", { method: "GET", headers: { Accept: "application/vnd.sap.adt.inactiveobjects+xml, application/xml, text/xml" } });
      if (!inactiveBefore.ok) { await inactiveBefore.body?.cancel(); return { ok: false, status: 502, state: "selection-text-activation-unconfirmed", programName: name, message: `Selection labels were saved, but SAP's inactive-object list could not be read before text-pool activation (HTTP ${inactiveBefore.status}). Report source status was not changed.` }; }
      const inactiveBeforeXml = await inactiveBefore.text();
      const refs = inactiveTextPoolReferences(inactiveBeforeXml, name);
      if (refs.length) {
        const references = refs.map(ref => `<adtcore:objectReference adtcore:name="${escapeXml(ref.name)}" adtcore:uri="${escapeXml(ref.uri)}" adtcore:type="${escapeXml(ref.type)}"${ref.parentUri ? ` adtcore:parentUri="${escapeXml(ref.parentUri)}"` : ""}/>`).join("");
        const activationBody = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${references}</adtcore:objectReferences>`;
        const activationResponse = await call("/sap/bc/adt/activation?method=activate&preauditRequested=false", { method: "POST", body: activationBody, headers: { "Content-Type": "application/vnd.sap.adt.activation+xml; charset=utf-8", Accept: "application/vnd.sap.adt.activation+xml, application/xml, text/xml" } });
        activationHttpStatus = activationResponse.status;
        const activationResponseBody = (await activationResponse.text()).slice(0, 3000);
        if (!activationResponse.ok) return { ok: false, status: 502, state: "selection-text-activation-failed", programName: name, activationHttpStatus, message: `SAP selection-text activation returned HTTP ${activationHttpStatus}.${activationResponseBody ? ` ${activationResponseBody.slice(0, 800)}` : ""}` };
        if (/<(?:\w+:)?message\b[^>]*(?:severity=["'](?:error|fatal)|type=["'](?:error|fatal))/i.test(activationResponseBody) || /<(?:(?:\w+):)?error\b/i.test(activationResponseBody)) return { ok: false, status: 502, state: "selection-text-activation-errors", programName: name, activationHttpStatus, message: `SAP returned activation diagnostics for the selection-text pool. ${activationResponseBody.slice(0, 800)}` };
      }
      const inactiveAfter = await call("/sap/bc/adt/activation/inactiveobjects", { method: "GET", headers: { Accept: "application/vnd.sap.adt.inactiveobjects+xml, application/xml, text/xml" } });
      if (!inactiveAfter.ok) { await inactiveAfter.body?.cancel(); return { ok: false, status: 502, state: "selection-text-activation-unconfirmed", programName: name, activationHttpStatus, message: `SAP accepted the selection-text activation request, but JDAP could not verify the inactive-object status (HTTP ${inactiveAfter.status}).` }; }
      const inactiveAfterXml = await inactiveAfter.text();
      if (inactiveAfterXml.trim() && isTargetListedInactive(inactiveAfterXml, name, "REPT")) return { ok: false, status: 502, state: "selection-text-still-inactive", programName: name, activationHttpStatus, message: `SAP still lists the selection-text pool for ${name} as inactive.` };
    }

    const readSelectionSource = async version => {
      const path = `${textUri}/source/selections${version ? `?version=${version}` : ""}`;
      const read = await call(path, { method: "GET", headers: { Accept: "application/vnd.sap.adt.textelements.selections.v1" } });
      if (!read.ok) return { response: read, source: "" };
      return { response: read, source: await read.text() };
    };
    const matchesEntries = source => {
      const savedEntries = new Map([...source.matchAll(/^\s*([A-Z0-9_]{1,8})\s*=(.*)$/gim)].map(([, key, value]) => [key.toUpperCase(), value.trim()]));
      return entries.every(({ name: key, text }) => savedEntries.get(key.toUpperCase()) === text.trim());
    };
    let readBack = await readSelectionSource(activate ? "" : "inactive");
    let readBackVersion = activate ? "active" : "inactive";
    if (!readBack.response.ok) return await fail(readBack.response, `${readBackVersion} read-back`);
    if (!matchesEntries(readBack.source) && !activate) {
      // SAP releases differ on whether a text-element PUT is exposed through
      // the active/default or inactive source selector. Accept only an exact
      // match from either view; never infer persistence from HTTP 200 alone.
      const activeReadBack = await readSelectionSource("");
      if (!activeReadBack.response.ok) return await fail(activeReadBack.response, "active read-back");
      if (matchesEntries(activeReadBack.source)) {
        readBack = activeReadBack;
        readBackVersion = "active";
      }
    }
    const missing = entries.filter(({ name: key, text }) => {
      const savedEntries = new Map([...readBack.source.matchAll(/^\s*([A-Z0-9_]{1,8})\s*=(.*)$/gim)].map(([, savedKey, value]) => [savedKey.toUpperCase(), value.trim()]));
      return savedEntries.get(key.toUpperCase()) !== text.trim();
    }).map(({ name: key }) => key);
    if (missing.length) {
      const emptyReadBack = readBack.source.length === 0;
      return { ok: false, status: 502, state: "selection-text-save-unverified", programName: name, missingLabels: missing, saveHttpStatus, readBackHttpStatus: readBack.response.status, selectionEtagPresent: Boolean(selectionEtag), saveEtagPresent: Boolean(saveEtag), readBackSourceLength: readBack.source.length, readBackSource: readBack.source.slice(0, 1200), message: `SAP returned HTTP ${saveHttpStatus} for selection-text save, but ${activate ? "active" : "active and inactive"} read-back does not contain the approved labels for ${missing.join(", ")}.${emptyReadBack ? " SAP returned an empty selection-text resource (0 bytes) after the save." : ""} ${activate ? "Selection-text pool activation could not be confirmed." : "Selection-text pool activation was not requested."}` };
    }
    return { ok: true, state: activate ? "selection-texts-verified" : `selection-texts-saved-${readBackVersion}-verified`, programName: name, count: entries.length, saveHttpStatus, activationHttpStatus, readBackVersion, language, selectionTextPoolActivationRequested: activate, message: `${activate ? "Saved, activated and verified" : `Saved and verified in the ${readBackVersion} text pool`} all ${entries.length} approved selection-screen label(s) for ${name} in language ${language}.` };
  } catch (error) {
    return { ok: false, status: error?.name === "AbortError" ? 504 : 502, state: error?.name === "AbortError" ? "timeout" : "selection-text-save-failed", message: error?.name === "AbortError" ? "SAP text-pool update timed out. Check the SAP program before retrying." : `Could not write approved selection labels: ${error.message}` };
  } finally {
    if (lockHandle) {
      try { await call(`${textUri}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, { method: "POST", body: "", headers: { Accept: "application/vnd.sap.as+xml" } }); } catch { /* preserve the primary SAP response */ }
    }
    clearTimeout(timer);
  }
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]);
}

function isEmptyGeneratedReport(source, name) {
  const remaining = String(source || "").replace(/^\uFEFF/, "").split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("*") && !line.startsWith('"'))
    .join(" ");
  return new RegExp(`^(?:REPORT|PROGRAM)\\s+${name}\\s*\\.\\s*$`, "i").test(remaining);
}

function comparableSavedAbapSource(source = "") {
  return String(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
    .split("\n").map(line => line.trim())
    .filter(line => line && !line.startsWith("*") && !line.startsWith('"'))
    .join("\n");
}

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") || "").split(/,\s*(?=[^;,\s]+=)/);
  return values.map(value => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function mergeCookieHeaders(current, response) {
  const cookies = new Map((current || "").split(/;\s*/).filter(Boolean).map(pair => [pair.slice(0, pair.indexOf("=")), pair]));
  for (const pair of cookieHeader(response).split(/;\s*/).filter(Boolean)) cookies.set(pair.slice(0, pair.indexOf("=")), pair);
  return [...cookies.values()].join("; ");
}

function hasCookie(cookie, name) {
  return String(cookie || "").split(/;\s*/).some(pair => pair.slice(0, pair.indexOf("=")).toLowerCase() === name.toLowerCase());
}

async function ensureOk(response, action) {
  if (response.ok) return;
  const text = (await response.text()).slice(0, 1200);
  throw new Error(`SAP ${action} returned HTTP ${response.status}${text ? `: ${text}` : ""}`);
}

/** Creates a report in $TMP, or completes a blank generated shell, and saves source inactive. It never activates. */
export async function createInactiveAbapProgram({ programName, description, source, approvalId, packageName = "$TMP", transportRequest = "" }, env = process.env, fetchImpl = fetch) {
  const config = readConfig(env);
  if (!config.configured) return { ok: false, status: 409, state: "not-configured", message: "SAP ADT is not configured." };
  if (!config.username || !config.password) return { ok: false, status: 409, state: "missing-credentials", message: "SAP ADT credentials are not configured." };
  const name = String(programName || "").trim().toUpperCase();
  const text = String(description || "").trim();
  if (!/^Z[A-Z0-9_]{1,39}$/.test(name)) return { ok: false, status: 400, state: "invalid-program-name", message: "Use a customer program name beginning with Z (2–40 characters, A–Z, 0–9, underscore)." };
  if (!text || text.length > 60) return { ok: false, status: 400, state: "invalid-description", message: "Description must contain 1–60 characters." };
  if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source, "utf8") > MAX_CREATE_SOURCE_BYTES) return { ok: false, status: 400, state: "invalid-source", message: "ABAP source is required and must not exceed 200,000 bytes." };
  const declaration = source.match(/^\s*(REPORT|PROGRAM)\s+([A-Z0-9_]+)/im);
  if (!declaration) return { ok: false, status: 400, state: "invalid-source", message: "Source must declare a REPORT or PROGRAM." };
  if (declaration[2].toUpperCase() !== name) return { ok: false, status: 400, state: "program-name-mismatch", message: `The source declares ${declaration[2]}, but the requested SAP object name is ${name}.` };
  if (!approvalId) return { ok: false, status: 400, state: "approval-required", message: "An approved JDAP draft is required." };
  const packageRef = String(packageName || "").trim().toUpperCase();
  const corrNr = String(transportRequest || "").trim().toUpperCase();
  const transportable = packageRef !== "$TMP";
  if (transportable && !/^\/?[A-Z0-9_]+(?:\/[A-Z0-9_]+)*\/?$/.test(packageRef)) return { ok: false, status: 400, state: "invalid-package", message: "Enter a valid transportable SAP package name; $TMP is only for local, untransported objects." };
  if (transportable && !/^[A-Z0-9]{3,20}K\d{6}$/.test(corrNr)) return { ok: false, status: 400, state: "transport-request-required", message: "Select a modifiable Workbench transport request for a transportable package." };
  if (!transportable && corrNr) return { ok: false, status: 400, state: "package-transport-mismatch", message: "A transport request cannot be assigned to the local $TMP package." };

  const base = config.baseUrl;
  const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  const adtConnectionId = randomUUID();
  const common = {
    Authorization: auth,
    Accept: "application/xml, text/xml",
    // ADT expects the X- prefixed header to bind a lock and the following
    // source PUT to the same stateful ABAP session.
    "x-sap-adt-sessiontype": "stateful",
    "sap-adt-connection-id": adtConnectionId,
    "sap-contextid-accept": "header"
  };
  if (config.client) common["sap-client"] = config.client;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let created = false;
  let recoveringBlankShell = false;
  let lockHandle = "";
  let cookie = "";
  let csrf = "";
  let securitySessionMode = "create";
  const csrfProbeStatuses = [];
  const lockSessionDiagnostics = { sapContextIdReturnedByLock: false, sapContextIdHeaderReturnedByLock: false, sapContextIdSentWithSourcePut: false, sapContextIdHeaderSentWithSourcePut: false, statefulHeaderSentWithLock: false, statefulHeaderSentWithSourcePut: false };
  let sapContextId = "";
  const request = async (path, options = {}) => {
    const outgoingHeaders = {
      ...common,
      "sap-adt-request-id": randomUUID(),
      "x-sap-security-session": securitySessionMode,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(sapContextId ? { "sap-contextid": sapContextId } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(options.headers || {})
    };
    if (path.includes("_action=LOCK")) lockSessionDiagnostics.statefulHeaderSentWithLock = String(outgoingHeaders["x-sap-adt-sessiontype"] || "").toLowerCase() === "stateful";
    if (options.method === "PUT" && path.includes("/source/main?lockHandle=")) {
      lockSessionDiagnostics.sapContextIdSentWithSourcePut = hasCookie(outgoingHeaders.Cookie, "sap-contextid");
      lockSessionDiagnostics.sapContextIdHeaderSentWithSourcePut = Boolean(outgoingHeaders["sap-contextid"]);
      lockSessionDiagnostics.statefulHeaderSentWithSourcePut = String(outgoingHeaders["x-sap-adt-sessiontype"] || "").toLowerCase() === "stateful";
    }
    const response = await fetchImpl(`${base}${path}`, {
      ...options,
      signal: controller.signal,
      redirect: "manual",
      headers: outgoingHeaders
    });
    // SAP may issue or rotate its stateful-session cookie on the LOCK response.
    // Preserve it before the next PUT/UNLOCK so they remain in the lock-holding session.
    if (path.includes("_action=LOCK")) {
      lockSessionDiagnostics.sapContextIdReturnedByLock = hasCookie(cookieHeader(response), "sap-contextid");
      lockSessionDiagnostics.sapContextIdHeaderReturnedByLock = Boolean(response.headers.get("sap-contextid"));
    }
    cookie = mergeCookieHeaders(cookie, response);
    const returnedContextId = response.headers.get("sap-contextid");
    if (returnedContextId !== null) sapContextId = returnedContextId.trim() && returnedContextId.trim() !== "0" ? returnedContextId.trim() : "";
    return response;
  };
  try {
    const readToken = async (path, accept) => {
      const response = await request(path, { method: "GET", headers: { "x-csrf-token": "Fetch", Accept: accept } });
      const status = response.status;
      csrfProbeStatuses.push(`${path} HTTP ${status}`);
      const token = response.headers.get("x-csrf-token") || "";
      await response.body?.cancel();
      return { status, token };
    };
    let tokenResult = await readToken("/sap/bc/adt/core/http/sessions", "application/vnd.sap.adt.core.http.session.v3+xml, application/xml");
    csrf = tokenResult.token;
    if (!csrf) {
      // sap-usercontext carries the client selection; it does not prove that ADT opened a security session.
      // When the session resource is unavailable on classic NetWeaver, explicitly create on discovery.
      securitySessionMode = "create";
      tokenResult = await readToken(DISCOVERY_PATH, "application/atomsvc+xml, application/xml, text/xml");
      csrf = tokenResult.token;
    }
    if (csrf.trim().toLowerCase() === "required" || csrf.trim().toLowerCase() === "fetch") csrf = "";
    if (!csrf) throw new Error(`SAP ADT did not return an X-CSRF-Token; no object was created. Token checks: ${csrfProbeStatuses.join("; ")}.`);
    securitySessionMode = "use";

    const lower = name.toLowerCase();
    const existing = await request(`/sap/bc/adt/programs/programs/${lower}/source/main`, { method: "GET", headers: { Accept: "text/plain" } });
    if (existing.status === 200) {
      const existingSource = await readLimitedText(existing);
      if (transportable) return { ok: false, status: 409, state: "transport-create-requires-new-object", message: `SAP program ${name} already exists. JDAP will not move or reassign an existing object as part of transportable creation.` };
      if (!isEmptyGeneratedReport(existingSource, name)) {
        return { ok: false, status: 409, state: "program-already-exists", message: `SAP program ${name} already contains source. JDAP did not change it.` };
      }
      recoveringBlankShell = true;
    } else {
      await existing.body?.cancel();
      if (existing.status !== 404) throw new Error(`SAP program existence check returned HTTP ${existing.status}; no object was created.`);
    }

    if (!recoveringBlankShell) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="PROG/P" adtcore:description="${escapeXml(text)}" adtcore:language="EN" adtcore:name="${name}" adtcore:masterLanguage="EN" adtcore:responsible="${escapeXml(config.username.toUpperCase())}"><adtcore:packageRef adtcore:name="${escapeXml(packageRef)}"/></program:abapProgram>`;
      const createPath = `/sap/bc/adt/programs/programs${corrNr ? `?corrNr=${encodeURIComponent(corrNr)}` : ""}`;
      const createResponse = await request(createPath, { method: "POST", body: xml, headers: { "Content-Type": "application/vnd.sap.adt.programs.programs+xml; charset=utf-8", Accept: "application/vnd.sap.adt.programs.programs+xml" } });
      await ensureOk(createResponse, "program creation");
      await createResponse.body?.cancel();
      created = true;
    }
    const lockResponse = await request(`/sap/bc/adt/programs/programs/${lower}?_action=LOCK&accessMode=MODIFY`, { method: "POST", body: "", headers: { Accept: "application/vnd.sap.as+xml" } });
    await ensureOk(lockResponse, "program lock");
    const lockXml = await lockResponse.text();
    lockHandle = lockXml.match(/<(?:\w+:)?LOCK_HANDLE>([^<]+)<\/(?:\w+:)?LOCK_HANDLE>/i)?.[1] || lockXml.match(/lockHandle="([^"]+)"/i)?.[1] || "";
    if (!lockHandle) throw new Error("SAP created the object but did not return a lock handle; source was not saved and the object remains incomplete.");

    const sourceQuery = new URLSearchParams({ lockHandle, ...(corrNr ? { corrNr } : {}) });
    const sourceResponse = await request(`/sap/bc/adt/programs/programs/${lower}/source/main?${sourceQuery}`, { method: "PUT", body: source, headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "text/plain" } });
    await ensureOk(sourceResponse, "source save");
    await sourceResponse.body?.cancel();

    const unlockResponse = await request(`/sap/bc/adt/programs/programs/${lower}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, { method: "POST", body: "", headers: { Accept: "application/vnd.sap.as+xml" } });
    lockHandle = "";
    await ensureOk(unlockResponse, "program unlock");
    await unlockResponse.body?.cancel();
    // SAP can return HTTP 200 for the source PUT without making the object
    // readable at the requested repository name. Never report creation as
    // successful until ADT returns and matches the saved inactive source.
    let sourceReadBack = await request(`/sap/bc/adt/programs/programs/${lower}/source/main`, { method: "GET", headers: { Accept: "text/plain" } });
    let sourceReadBackStatus = sourceReadBack.status;
    if (sourceReadBack.status === 404) {
      await sourceReadBack.body?.cancel();
      sourceReadBack = await request(`/sap/bc/adt/programs/programs/${lower}/source/main?version=inactive`, { method: "GET", headers: { Accept: "text/plain" } });
      sourceReadBackStatus = sourceReadBack.status;
    }
    if (!sourceReadBack.ok) {
      await sourceReadBack.body?.cancel();
      throw new Error(`SAP accepted source save, but ADT could not read back ${name} (HTTP ${sourceReadBackStatus}); object persistence was not confirmed.`);
    }
    const verifiedSource = await readLimitedText(sourceReadBack);
    if (comparableSavedAbapSource(verifiedSource) !== comparableSavedAbapSource(source)) {
      throw new Error(`SAP accepted source save, but ADT read-back for ${name} does not match the approved source; object persistence was not confirmed.`);
    }
    return { ok: true, state: "saved-inactive", created: true, programName: name, package: packageRef, transportRequest: corrNr || null, approvalId, recoveredBlankShell: recoveringBlankShell, activated: false, message: transportable ? `The approved report and source were saved inactive in package ${packageRef} and assigned to transport ${corrNr}. JDAP did not activate, release, or import it.` : recoveringBlankShell ? "The approved source was saved into the existing blank report in $TMP as an inactive object. JDAP did not activate or transport it." : "The report and source were saved in $TMP as an inactive object. JDAP did not activate or transport it." };
  } catch (error) {
    if (lockHandle) {
      try { await request(`/sap/bc/adt/programs/programs/${name.toLowerCase()}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, { method: "POST", body: "", headers: { Accept: "application/vnd.sap.as+xml" } }); } catch { /* leave SAP error in primary response */ }
    }
    const timeout = error?.name === "AbortError";
    const lockDiagnosticSuffix = /SAP source save returned HTTP 423/.test(error?.message || "")
      ? ` Lock-session diagnostics (session values hidden): stateful header with LOCK=${lockSessionDiagnostics.statefulHeaderSentWithLock}, sap-contextid cookie returned by LOCK=${lockSessionDiagnostics.sapContextIdReturnedByLock}, sap-contextid header returned by LOCK=${lockSessionDiagnostics.sapContextIdHeaderReturnedByLock}, stateful header with source PUT=${lockSessionDiagnostics.statefulHeaderSentWithSourcePut}, sap-contextid cookie sent with source PUT=${lockSessionDiagnostics.sapContextIdSentWithSourcePut}, sap-contextid header sent with source PUT=${lockSessionDiagnostics.sapContextIdHeaderSentWithSourcePut}.`
      : "";
    return { ok: false, status: timeout ? 504 : 502, state: created || recoveringBlankShell ? "partial-create" : timeout ? "timeout" : "sap-request-failed", created: created || recoveringBlankShell, programName: created || recoveringBlankShell ? name : undefined, recoveredBlankShell: recoveringBlankShell, activated: false, message: timeout ? (created || recoveringBlankShell ? "SAP request timed out while saving the report; check SAP ADT before retrying." : "SAP ADT request timed out; no object was created.") : `${error.message}${lockDiagnosticSuffix}` };
  } finally { clearTimeout(timer); }
}

