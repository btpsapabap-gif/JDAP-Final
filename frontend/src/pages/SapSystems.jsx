import React, { useEffect, useState } from "react";
import { Database, RefreshCw, ShieldCheck, Radio, AlertTriangle, Code2 } from "lucide-react";

function StatePill({ state }) {
  const good = state === "reachable" || state === "readable";
  return <span className={`sap-state ${good ? "good" : state === "limit-not-honored" ? "warn" : "muted"}`}><i />{(state || "not checked").replaceAll("-", " ").toUpperCase()}</span>;
}

export default function SapSystems({ systems, entitySet = "", onEntitySetChange = () => {} }) {
  const [connection, setConnection] = useState(null);
  const [adtConnection, setAdtConnection] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [readCheck, setReadCheck] = useState(null);
  const [sample, setSample] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refreshConnection() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/sap/odata/connection");
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not check SAP connection.");
      setConnection(result);
      if (result.entitySet && !entitySet) onEntitySetChange(result.entitySet);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function checkAdtConnection() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/sap/adt/connection");
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not check SAP ADT connection.");
      setAdtConnection(result);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => { refreshConnection(); }, []);

  async function checkEntitySet() {
    if (!window.confirm("This sends a read request to the configured SAP entity set. SAP may return more than the requested one row; JDAP will discard record values and show only the returned count and field names. Continue?")) return;
    setBusy(true); setError(""); setReadCheck(null);
    try {
      const response = await fetch(`/api/sap/odata/read-check?entitySet=${encodeURIComponent(entitySet)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not check SAP entity-set access.");
      setReadCheck(result);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function previewLiveSample() {
    if (!window.confirm("Read one live SAP OData row over the configured connection and display it here? JDAP keeps only the first row, does not save it, and discards any additional rows SAP returns. If the connection uses HTTP, credentials and data are unencrypted in transit.")) return;
    setBusy(true); setError(""); setSample(null);
    try {
      const response = await fetch(`/api/sap/odata/sample?entitySet=${encodeURIComponent(entitySet)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not read the SAP sample.");
      setSample(result);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function discoverMetadata() {
    setBusy(true); setError(""); setMetadata(null);
    try {
      const response = await fetch("/api/sap/odata/metadata");
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not discover OData metadata.");
      setMetadata(result);
      if (result.state === "discovered" && result.entitySets.length && !result.entitySets.some(set => set.name === entitySet)) {
        onEntitySetChange(result.entitySets[0].name);
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return <div className="sap-page">
    <section className="panel sap-connection">
      <div className="panelhead"><div><span className="eyebrow">LIVE CONNECTION</span><h2>SAP Gateway OData</h2></div><div className="historyactions"><button className="secondary" onClick={refreshConnection} disabled={busy}><RefreshCw size={14} /> Refresh status</button><button className="primary" onClick={discoverMetadata} disabled={busy || connection?.state !== "reachable"}>{busy ? "Discovering…" : "Discover service model"}</button></div></div>
      <p className="sap-intro">OData connects to live SAP business data. ADT is the separate ABAP development repository route. Testing Center can read source and, with separate opt-in controls, save an approved report and its selection labels to $TMP, then request activation. JDAP does not create or release a transport.</p>
      <div className="sap-status-grid">
        <div className="sap-status-card"><Radio size={18}/><div><small>OData metadata</small><StatePill state={connection?.state}/></div></div>
        <div className="sap-status-card"><Database size={18}/><div><small>{connection?.serviceName || "Entity set"}</small><b>{entitySet || readCheck?.entitySet || connection?.entitySet || "Configured in .env"}</b></div></div>
        <div className="sap-status-card"><Code2 size={18}/><div><small>ABAP repository · ADT</small><StatePill state={adtConnection?.state || "not checked"}/><button className="sap-inline-check" onClick={checkAdtConnection} disabled={busy}>{busy ? "Checking…" : "Check ADT"}</button></div></div>
        <div className="sap-status-card"><ShieldCheck size={18}/><div><small>Object changes</small><StatePill state="not enabled"/></div></div>
      </div>
      {connection?.message && <p className="sap-message">{connection.message}{connection.transport && <> · Transport: <b>{connection.transport}{connection.transport === "HTTP" ? " (unencrypted)" : ""}</b></>}</p>}
      {adtConnection?.message && <p className="sap-message">ADT: {adtConnection.message}{adtConnection.transport && <> · Transport: <b>{adtConnection.transport}{adtConnection.transport === "HTTP" ? " (unencrypted)" : ""}</b></>}</p>}
      {error && <div className="error">{error}</div>}
    </section>

    <section className="panel sap-read-panel">
      <div className="panelhead"><div><span className="eyebrow">CONTROLLED READ</span><h2>Entity-set access</h2></div><div className="historyactions"><button className="secondary" onClick={checkEntitySet} disabled={busy || connection?.state !== "reachable"}>{busy ? "Checking…" : "Check fields only"}</button><button className="primary" onClick={previewLiveSample} disabled={busy || connection?.state !== "reachable"}>{busy ? "Reading…" : "Preview one live row"}</button></div></div>
      {metadata?.state === "discovered" && <div className="metadata-picker"><label htmlFor="sapEntitySet">Discovered SAP entity set</label><select id="sapEntitySet" value={entitySet} onChange={event => {onEntitySetChange(event.target.value);setReadCheck(null);setSample(null)}}>{metadata.entitySets.map(item => <option key={item.name} value={item.name}>{item.name} · {item.properties.length} fields</option>)}</select><span>{metadata.transport} · {metadata.serviceName} · metadata fields only</span></div>}
      {metadata?.state === "discovered" && <details className="metadata-fields"><summary>Show field names and types ({metadata.entitySets.find(item => item.name === entitySet)?.properties.length || 0})</summary><div>{metadata.entitySets.find(item => item.name === entitySet)?.properties.map(field => <span key={field.name}><b>{field.name}</b><small>{field.type}{field.nullable ? "" : " · required"}</small></span>)}</div></details>}
      {metadata && metadata.state !== "discovered" && <div className="sap-read-result"><StatePill state={metadata.state}/><span> {metadata.message}</span></div>}
      <p><b>Check fields only</b> discards row values. <b>Preview one live row</b> displays only the first returned row in this page and does not save it. SAP may ignore the requested row limit; JDAP caps the response body and discards extra rows.</p>
      {readCheck && <div className={`sap-read-result ${readCheck.state === "limit-not-honored" ? "warn" : ""}`}>
        <div className="sap-read-title">{readCheck.state === "limit-not-honored" && <AlertTriangle size={16}/>}<StatePill state={readCheck.state}/><span>{readCheck.message}</span></div>
        {readCheck.rowsReceived !== undefined && <p>Requested: {readCheck.requestedRows} · Received: {readCheck.rowsReceived} · HTTP {readCheck.httpStatus}</p>}
        {readCheck.fields?.length > 0 && <p>Fields: <code>{readCheck.fields.join(", ")}</code></p>}
      </div>}
      {sample && <div className="sap-live-sample"><div className="sap-read-title"><StatePill state={sample.state}/><span>{sample.message}</span><span className="sap-transport">{sample.transport} · {sample.entitySet}</span></div>{sample.sample && <pre>{JSON.stringify(sample.sample, null, 2)}</pre>}</div>}
    </section>

    <section className="panel sap-mock-panel"><div className="panelhead"><div><span className="eyebrow">DEMO LANDSCAPE</span><h2>Mock SAP profiles</h2></div></div><SystemCards systems={systems}/></section>
  </div>;
}

function SystemCards({ systems = [] }) {
  return <div className="systemcards">{systems.map(system => <div className="systemcard" key={system.id}><Database size={17}/><b>{system.name}</b><span>{system.type} · {system.release}</span><em>DEMO PROFILE</em></div>)}</div>;
}
