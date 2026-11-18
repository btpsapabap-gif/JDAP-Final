function getConfig(env = process.env) {
  const serviceUrl = (env.SAP_ODATA_SERVICE_URL || "").trim().replace(/\/+$/, "");
  if (!serviceUrl) return { configured: false };
  let parsed;
  try { parsed = new URL(serviceUrl); } catch { throw new Error("SAP_ODATA_SERVICE_URL must be a valid absolute URL"); }
  const httpAllowed = env.SAP_ODATA_ALLOW_HTTP === "true";
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && httpAllowed)) || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/sap\/opu\/odata\/sap\/[A-Za-z0-9_]+$/i.test(parsed.pathname)) {
    throw new Error("SAP_ODATA_SERVICE_URL must use HTTPS, or HTTP with SAP_ODATA_ALLOW_HTTP=true, and point to /sap/opu/odata/sap/<SERVICE_NAME> without credentials or query parameters");
  }
  return {
    configured: true,
    serviceUrl,
    username: env.SAP_ODATA_USERNAME || "",
    password: env.SAP_ODATA_PASSWORD || "",
    client: env.SAP_ODATA_CLIENT || "",
    entitySet: env.SAP_ODATA_ENTITY_SET || "",
    timeoutMs: Math.max(1000, Math.min(Number(env.SAP_ODATA_TIMEOUT_MS) || 8000, 30000))
  };
}

function xmlAttribute(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2]?.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">") || "";
}

function parseODataMetadata(xml) {
  const types = new Map();
  const typePattern = /<((?:[\w.-]+:)?EntityType)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of xml.matchAll(typePattern)) {
    const typeName = xmlAttribute(match[2], "Name");
    const properties = [];
    for (const property of match[3].matchAll(/<(?:[\w.-]+:)?Property\b([^>]*?)\/?>/gi)) {
      const name = xmlAttribute(property[1], "Name");
      if (name) properties.push({ name, type: xmlAttribute(property[1], "Type"), nullable: xmlAttribute(property[1], "Nullable") !== "false" });
    }
    if (typeName) types.set(typeName, properties);
  }
  const entitySets = [];
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?EntitySet\b([^>]*?)\/?>/gi)) {
    const name = xmlAttribute(match[1], "Name");
    const entityType = xmlAttribute(match[1], "EntityType");
    if (!name) continue;
    const localTypeName = entityType.split(".").at(-1);
    entitySets.push({ name, entityType, properties: types.get(localTypeName) || [] });
  }
  return entitySets;
}

async function readLimitedBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", tooLarge: false };
  const chunks = [];
  let byteCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maxBytes) {
      await reader.cancel();
      return { text: "", tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes), tooLarge: false };
}

/** Checks OData V2 metadata using GET only. It does not read business records or write SAP data. */
export async function checkSapODataService(env = process.env, fetchImpl = fetch) {
  const config = getConfig(env);
  if (!config.configured) return { configured: false, state: "not-configured", message: "SAP OData is not configured; JDAP remains in mock SAP mode." };
  const serviceName = new URL(config.serviceUrl).pathname.split("/").filter(Boolean).at(-1);
  if (!config.username || !config.password) return { configured: true, state: "missing-credentials", message: "SAP OData service URL is set, but username/password are missing." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: "application/xml, application/atom+xml",
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
  };
  const metadataUrl = new URL(`${config.serviceUrl}/$metadata`);
  if (config.client) metadataUrl.searchParams.set("sap-client", config.client);
  try {
    const response = await fetchImpl(metadataUrl, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    await response.body?.cancel();
    if (response.status >= 200 && response.status < 300) {
      return { configured: true, state: "reachable", serviceName, entitySet: config.entitySet || null, transport: new URL(config.serviceUrl).protocol.slice(0, -1).toUpperCase(), httpStatus: response.status, checkedAt: new Date().toISOString(), message: "The configured SAP OData service metadata is reachable. No business records were read." };
    }
    const state = response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "service-not-found" : "http-error";
    return { configured: true, state, httpStatus: response.status, checkedAt: new Date().toISOString(), message: `SAP OData metadata returned HTTP ${response.status}.` };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { configured: true, state: timeout ? "timeout" : "unreachable", diagnosticCode: error?.cause?.code || undefined, checkedAt: new Date().toISOString(), message: timeout ? "SAP OData metadata request timed out." : "Could not reach SAP OData. Check the configured HTTP/HTTPS endpoint, network route, and Gateway service." };
  } finally { clearTimeout(timer); }
}

/** Reads OData V2 service metadata and returns entity-set names and field types only. */
export async function discoverSapODataMetadata(env = process.env, fetchImpl = fetch) {
  const config = getConfig(env);
  if (!config.configured) return { configured: false, state: "not-configured", message: "SAP OData is not configured." };
  if (!config.username || !config.password) return { configured: true, state: "missing-credentials", message: "SAP OData username/password are missing." };
  const serviceName = new URL(config.serviceUrl).pathname.split("/").filter(Boolean).at(-1);
  const metadataUrl = new URL(`${config.serviceUrl}/$metadata`);
  if (config.client) metadataUrl.searchParams.set("sap-client", config.client);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: "application/xml, application/atom+xml",
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
  };
  try {
    const response = await fetchImpl(metadataUrl, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    if (!response.ok) {
      await response.body?.cancel();
      const state = response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "service-not-found" : "http-error";
      return { configured: true, state, httpStatus: response.status, message: `SAP OData metadata returned HTTP ${response.status}.` };
    }
    const body = await readLimitedBody(response, 1048576);
    if (body.tooLarge) return { configured: true, state: "metadata-too-large", httpStatus: response.status, message: "SAP OData metadata exceeded the 1 MiB discovery limit." };
    const entitySets = parseODataMetadata(body.text);
    if (!entitySets.length) return { configured: true, state: "metadata-unrecognized", httpStatus: response.status, message: "Metadata was reachable, but JDAP did not find any OData entity sets." };
    return { configured: true, state: "discovered", serviceName, transport: metadataUrl.protocol.slice(0, -1).toUpperCase(), httpStatus: response.status, entitySets, checkedAt: new Date().toISOString(), message: `Discovered ${entitySets.length} entity set(s). Metadata contains field names and types only.` };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { configured: true, state: timeout ? "timeout" : "unreachable", diagnosticCode: error?.cause?.code || undefined, checkedAt: new Date().toISOString(), message: timeout ? "SAP OData metadata discovery timed out." : "Could not read SAP OData metadata. Check the configured HTTP/HTTPS route and Gateway service." };
  } finally { clearTimeout(timer); }
}

/** Fetches at most one sanitized sample row for an explicitly requested, read-only workflow context. */
export async function readSapODataSample(env = process.env, fetchImpl = fetch, requestedEntitySet = "") {
  const config = getConfig(env);
  if (!config.configured) return { configured: false, state: "not-configured", message: "Configure SAP OData before requesting a live sample." };
  if (!config.username || !config.password) return { configured: true, state: "missing-credentials", message: "SAP OData username/password are missing." };
  const entitySet = String(requestedEntitySet || config.entitySet || "").trim();
  if (!entitySet || !/^[A-Za-z0-9_]+$/.test(entitySet)) return { configured: true, state: "missing-entity-set", message: "Select a valid SAP OData entity set." };

  const endpoint = new URL(`${config.serviceUrl}/${entitySet}`);
  endpoint.searchParams.set("$format", "json");
  endpoint.searchParams.set("$top", "1");
  if (config.client) endpoint.searchParams.set("sap-client", config.client);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
  };
  try {
    const response = await fetchImpl(endpoint, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    if (!response.ok) {
      await response.body?.cancel();
      return { configured: true, state: response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "entity-set-not-found" : "http-error", httpStatus: response.status, entitySet, message: `SAP OData sample read returned HTTP ${response.status}.` };
    }
    const body = await readLimitedBody(response, 262144);
    if (body.tooLarge) return { configured: true, state: "response-too-large", httpStatus: response.status, entitySet, message: "SAP returned more than 256 KiB for a one-row request. No row was passed to the workflow." };
    const payload = JSON.parse(body.text);
    const rows = Array.isArray(payload?.d?.results) ? payload.d.results : Array.isArray(payload?.value) ? payload.value : payload?.d && typeof payload.d === "object" ? [payload.d] : [];
    if (!rows.length) return { configured: true, state: "empty", httpStatus: response.status, entitySet, transport: endpoint.protocol.slice(0, -1).toUpperCase(), rowsReceived: 0, fields: [], sample: null, message: "The SAP entity set returned no rows." };

    const first = rows[0];
    const sample = {};
    for (const [key, value] of Object.entries(first).filter(([key]) => !key.startsWith("__")).slice(0, 40)) {
      if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
        const bounded = typeof value === "string" ? value.slice(0, 200) : value;
        if (JSON.stringify(sample).length + String(key).length + String(bounded).length > 6000) break;
        sample[key] = bounded;
      }
    }
    return {
      configured: true, state: "readable", httpStatus: response.status, entitySet,
      transport: endpoint.protocol.slice(0, -1).toUpperCase(), requestedRows: 1, rowsReceived: rows.length,
      extraRowsDiscarded: Math.max(0, rows.length - 1), fields: Object.keys(sample), sample,
      checkedAt: new Date().toISOString(), message: rows.length > 1 ? `SAP returned ${rows.length} rows; JDAP retained only the first row and discarded the rest.` : "One SAP row was read."
    };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { configured: true, state: timeout ? "timeout" : "unreachable", diagnosticCode: error?.cause?.code || undefined, entitySet, checkedAt: new Date().toISOString(), message: timeout ? "SAP OData sample read timed out." : "Could not read the SAP OData sample. Check the HTTP route, Gateway service, and credentials." };
  } finally { clearTimeout(timer); }
}

/** Requests a one-row OData sample and returns field names only; reports if SAP ignores $top. */
export async function checkSapODataEntitySet(env = process.env, fetchImpl = fetch, requestedEntitySet = "") {
  const config = getConfig(env);
  if (!config.configured) return { configured: false, state: "not-configured", message: "SAP OData is not configured." };
  if (!config.username || !config.password) return { configured: true, state: "missing-credentials", message: "SAP OData username/password are missing." };
  const entitySet = String(requestedEntitySet || config.entitySet || "").trim();
  if (!entitySet || !/^[A-Za-z0-9_]+$/.test(entitySet)) {
    return { configured: true, state: "missing-entity-set", message: "Select a valid SAP OData entity set." };
  }

  const endpoint = new URL(`${config.serviceUrl}/${entitySet}`);
  endpoint.searchParams.set("$format", "json");
  endpoint.searchParams.set("$top", "1");
  if (config.client) endpoint.searchParams.set("sap-client", config.client);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
  };
  try {
    const response = await fetchImpl(endpoint, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    if (!response.ok) {
      await response.body?.cancel();
      return { configured: true, state: response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "entity-set-not-found" : "http-error", httpStatus: response.status, entitySet, checkedAt: new Date().toISOString(), message: `SAP OData entity-set check returned HTTP ${response.status}.` };
    }
    const payload = await response.json();
    const rows = Array.isArray(payload?.d?.results) ? payload.d.results : Array.isArray(payload?.value) ? payload.value : payload?.d && typeof payload.d === "object" ? [payload.d] : [];
    const fields = rows.length ? Object.keys(rows[0]).filter(key => !key.startsWith("__")) : [];
    const limitIgnored = rows.length > 1;
    return { configured: true, state: limitIgnored ? "limit-not-honored" : "readable", httpStatus: response.status, entitySet, requestedRows: 1, rowsReceived: rows.length, fields, checkedAt: new Date().toISOString(), message: limitIgnored ? `SAP returned ${rows.length} rows despite the requested $top=1. Values were discarded; adjust the SAP service before using this for routine reads.` : rows.length ? "SAP returned the requested one-row sample. Record values were discarded." : "SAP accepted the read request, but the entity set returned no rows." };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { configured: true, state: timeout ? "timeout" : "unreachable", diagnosticCode: error?.cause?.code || undefined, entitySet: config.entitySet, checkedAt: new Date().toISOString(), message: timeout ? "SAP OData entity-set check timed out." : "Could not complete the SAP OData entity-set read." };
  } finally { clearTimeout(timer); }
}
