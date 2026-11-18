import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Play, ShieldCheck, Code2 } from "lucide-react";

function extractAbap(content = "") {
  return content.match(/## ABAP draft\s+```abap\s*([\s\S]*?)```/i)?.[1]?.trim() || "";
}

function hasSelectionTexts(content = "") {
  return /## Selection screen texts\s/i.test(content);
}

export default function TestingCenter({ initialSource = "", objectCreateEnabled = false, objectActivationEnabled = false }) {
  const [source, setSource] = useState(initialSource);
  const [sourceOrigin, setSourceOrigin] = useState(initialSource ? "Latest workflow draft" : "");
  const [release, setRelease] = useState("v750");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [programName, setProgramName] = useState("");
  const [adtToken, setAdtToken] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sapSyntaxBusy, setSapSyntaxBusy] = useState(false);
  const [sapSyntaxError, setSapSyntaxError] = useState("");
  const [sapSyntaxResult, setSapSyntaxResult] = useState(null);
  const [approvedDrafts, setApprovedDrafts] = useState([]);
  const [approvalId, setApprovalId] = useState("");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [deliveryToken, setDeliveryToken] = useState("");
  const [createConfirmation, setCreateConfirmation] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createResult, setCreateResult] = useState(null);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [prepareMessage, setPrepareMessage] = useState("");
  const [packageName, setPackageName] = useState("$TMP");
  const [transportRequests, setTransportRequests] = useState([]);
  const [transportRequest, setTransportRequest] = useState("");
  const [transportBusy, setTransportBusy] = useState(false);
  const [transportError, setTransportError] = useState("");

  useEffect(() => {
    let active = true;
    if (initialSource) {
      setSource(initialSource); setSourceOrigin("Latest workflow draft"); setResult(null);
      return () => { active = false; };
    }
    fetch("/api/workflows").then(r => r.json()).then(async workflows => {
      const latest = workflows.find(item => item.artifact_id);
      if (!latest) return;
      const response = await fetch(`/api/artifacts/${latest.artifact_id}`);
      const artifact = await response.json();
      const code = extractAbap(artifact.content || "");
      if (active && code) { setSource(code); setSourceOrigin("Loaded from saved workflow history"); }
    }).catch(() => {});
    return () => { active = false; };
  }, [initialSource]);

  useEffect(() => {
    fetch("/api/approvals").then(r => r.json()).then(items => {
      if (Array.isArray(items)) setApprovedDrafts(items.filter(item => item.status === "APPROVED" && /## ABAP draft\s+```abap/i.test(item.artifact_content || "")));
    }).catch(() => {});
  }, []);

  async function checkSyntax() {
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/abap/syntax-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, release })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Syntax check could not run.");
      setResult(data);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function retrieveFromSap() {
    setSourceBusy(true); setSourceError("");
    try {
      const response = await fetch(`/api/sap/adt/programs/${encodeURIComponent(programName.trim())}/source`, {
        headers: { Authorization: `Bearer ${adtToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.state || "Could not retrieve source from SAP ADT.");
      setSource(data.source || "");
      setSourceOrigin(`SAP ADT read · ${data.programName} · ${data.transport || "HTTP(S)"}`);
      setResult(null); setError("");
    } catch (e) { setSourceError(e.message); }
    finally { setSourceBusy(false); }
  }

  async function checkActiveSapSyntax() {
    setSapSyntaxBusy(true); setSapSyntaxError(""); setSapSyntaxResult(null);
    try {
      const response = await fetch(`/api/sap/adt/programs/${encodeURIComponent(programName.trim())}/syntax-check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adtToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.state || "SAP syntax check could not run.");
      setSapSyntaxResult(data);
    } catch (e) { setSapSyntaxError(e.message); }
    finally { setSapSyntaxBusy(false); }
  }

  async function createInSap() {
    setCreateBusy(true); setCreateError(""); setCreateResult(null);
    try {
      const response = await fetch("/api/sap/adt/programs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-JDAP-Delivery-Token": deliveryToken },
        body: JSON.stringify({ deliverApproved: true, approvalId, programName: createName.trim(), description: createDescription.trim(), confirmation: createConfirmation, packageName: packageName.trim(), transportRequest: packageName.trim().toUpperCase() === "$TMP" ? "" : transportRequest })
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.created || data.activated || data.selectionTexts || data.sapSyntaxCheck || data.activation) { setCreateResult({ ...data, ok: false }); return; }
        throw new Error(data.message || data.state || "Could not deliver the approved SAP report.");
      }
      setCreateResult(data);
    } catch (e) { setCreateError(e.message); }
    finally { setCreateBusy(false); }
  }

  async function loadCreateTransports() {
    setTransportBusy(true); setTransportError("");
    try {
      const response = await fetch("/api/sap/adt/transports", { headers: { Authorization: `Bearer ${deliveryToken}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.state || "Could not load SAP transport requests.");
      const candidates = (data.requests || []).filter(item => /^(?:D|MODIFIABLE)$/i.test(String(item.status || "")) && /^(?:K|WORKBENCH)$/i.test(String(item.type || "")));
      setTransportRequests(candidates);
      setTransportRequest(current => candidates.some(item => item.id === current) ? current : candidates[0]?.id || "");
      if (!candidates.length) setTransportError("SAP returned no modifiable Workbench requests for this ADT user.");
    } catch (e) { setTransportError(e.message); setTransportRequests([]); setTransportRequest(""); }
    finally { setTransportBusy(false); }
  }

  async function prepareSelectionTexts() {
    setPrepareBusy(true); setPrepareMessage(""); setCreateError("");
    try {
      const response = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/prepare-selection-texts`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || "Could not prepare selection labels for review.");
      setPrepareMessage(`${data.message} New approval: ${data.approvalId}. Open Approvals, review and approve it, then select that new draft here.`);
    } catch (e) { setPrepareMessage(e.message); }
    finally { setPrepareBusy(false); }
  }

  function selectApprovedDraft(id) {
    setApprovalId(id);
    setCreateError(""); setCreateResult(null);
    const draft = approvedDrafts.find(item => item.id === id);
    if (!draft) return;
    const draftSource = extractAbap(draft.artifact_content || "");
    setSource(draftSource);
    setSourceOrigin(`Selected approved draft · approval ${id.slice(0, 8)}`);
    setResult(null); setError("");
    const declaration = draftSource.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z0-9_]+)/im)?.[1] || "";
    setCreateName(declaration.toUpperCase());
    setCreateDescription((draft.artifact_title || "JDAP approved report").slice(0, 60));
  }

  const selectedApprovedDraft = approvedDrafts.find(item => item.id === approvalId);
  const selectionTextsMissing = selectedApprovedDraft && /\b(?:SELECT-OPTIONS|PARAMETERS)\b/i.test(extractAbap(selectedApprovedDraft.artifact_content || "")) && !hasSelectionTexts(selectedApprovedDraft.artifact_content || "");
  return <div className="testing-page">
    <section className="panel adt-source-panel">
      <div className="panelhead"><div><span className="eyebrow">LIVE SAP READ</span><h2>Load an existing ABAP program</h2></div><Code2 size={20} className="testing-icon"/></div>
      <p className="testing-copy">Retrieve one existing program through the configured ADT HTTP route, then inspect or syntax-check it here. This uses GET only; it does not change SAP. Source retrieval must be enabled by the JDAP administrator. HTTP does not encrypt SAP credentials or source text in transit.</p>
      <div className="adt-source-toolbar">
        <label>ABAP program name<input value={programName} onChange={event=>setProgramName(event.target.value)} placeholder="Z_EXISTING_PROGRAM" maxLength={40} autoCapitalize="characters"/></label>
        <label>JDAP read token<input type="password" value={adtToken} onChange={event=>setAdtToken(event.target.value)} placeholder="Enter the token configured in .env" autoComplete="off"/></label>
        <button className="secondary" onClick={retrieveFromSap} disabled={sourceBusy || !programName.trim() || !adtToken.trim()}>{sourceBusy ? "Reading from SAP…" : "Read source from SAP"}</button>
      </div>
      {sourceError && <div className="error">{sourceError}</div>}
      <small className="live-context-muted">The token is used for this request and is not saved in JDAP. Retrieved source remains in this page’s browser state and is not added to workflow history.</small>
      <div className="testing-toolbar sap-native-check-toolbar">
        <button className="secondary" onClick={checkActiveSapSyntax} disabled={sapSyntaxBusy || !programName.trim() || !adtToken.trim()}>{sapSyntaxBusy ? "Checking active SAP version…" : "Check active SAP syntax"}</button>
        <small className="live-context-muted">Runs SAP ADT checkruns against the active saved version of this program. It does not check the editor draft, activate anything, or run ATC.</small>
      </div>
      {sapSyntaxError && <div className="error">{sapSyntaxError}</div>}
      {sapSyntaxResult && <div className={`syntax-result ${sapSyntaxResult.state === "sap-syntax-ok" ? "success" : "failure"}`}>
        <div className="syntax-result-head">{sapSyntaxResult.state === "sap-syntax-ok" ? <CheckCircle2 size={16}/> : <AlertTriangle size={16}/>}<b>{sapSyntaxResult.message}</b><span>{sapSyntaxResult.programName} · active</span></div>
        {sapSyntaxResult.messages?.length > 0 && <ul>{sapSyntaxResult.messages.map((item, index) => <li key={`${item.code}-${item.line}-${index}`}><code>{item.severity}{item.line ? ` · line ${item.line}` : ""}</code> {item.message}</li>)}</ul>}
        <small>{sapSyntaxResult.note}</small>
      </div>}
    </section>
    <section className="panel adt-source-panel">
      <div className="panelhead"><div><span className="eyebrow">CONTROLLED SAP DELIVERY</span><h2>Deliver an approved report to SAP</h2></div><ShieldCheck size={20} className="testing-icon"/></div>
      <p className="testing-copy">One controlled action creates or finalizes the approved report, activates its source, then saves, activates, and verifies approved selection labels. New objects are assigned to the selected package and Workbench request. JDAP never releases or imports a transport. {objectCreateEnabled && objectActivationEnabled ? "Approved delivery is enabled." : "Approved delivery requires both creation and activation to be enabled."}</p>
      <div className="adt-source-toolbar">
        <label>Approved JDAP draft<select disabled={!objectCreateEnabled && !objectActivationEnabled} value={approvalId} onChange={event=>selectApprovedDraft(event.target.value)}><option value="">Choose an approved draft</option>{approvedDrafts.map(item=><option key={item.id} value={item.id}>{item.artifact_title} · approval {item.id.slice(0,8)}</option>)}</select></label>
        <label>SAP program name<input disabled={!objectCreateEnabled && !objectActivationEnabled} value={createName} onChange={event=>setCreateName(event.target.value.toUpperCase())} placeholder="Z_JDAP_REPORT" maxLength={40}/></label>
        <label>Program description<input disabled={!objectCreateEnabled} value={createDescription} onChange={event=>setCreateDescription(event.target.value)} placeholder="JDAP approved report" maxLength={60}/></label>
        <label>SAP package<select disabled={!objectCreateEnabled} value={packageName.toUpperCase() === "$TMP" ? "$TMP" : "__transportable__"} onChange={event=>{setPackageName(event.target.value === "$TMP" ? "$TMP" : "");setTransportError("")}}><option value="$TMP">$TMP · local only, no transport</option><option value="__transportable__">Transportable package</option></select></label>
        {packageName.toUpperCase() !== "$TMP" && <><label>Transportable package name<input disabled={!objectCreateEnabled} value={packageName === "__transportable__" ? "" : packageName} onChange={event=>setPackageName(event.target.value.toUpperCase())} placeholder="Z_PACKAGE" maxLength={30}/></label><button className="secondary" type="button" onClick={loadCreateTransports} disabled={transportBusy || !deliveryToken.trim()}>{transportBusy ? "Loading requests…" : "Load modifiable Workbench requests"}</button><label>Workbench transport request<select disabled={!objectCreateEnabled || !transportRequests.length} value={transportRequest} onChange={event=>setTransportRequest(event.target.value)}><option value="">Choose a modifiable request</option>{transportRequests.map(item=><option key={item.id} value={item.id}>{item.id} · {item.description || "Workbench request"}</option>)}</select></label></>}
        <label>JDAP delivery token<input disabled={!objectCreateEnabled || !objectActivationEnabled} type="password" value={deliveryToken} onChange={event=>setDeliveryToken(event.target.value)} placeholder="Token configured for approved SAP activation" autoComplete="off"/></label>
        <label>Type DELIVER APPROVED REPORT to confirm<input disabled={!objectCreateEnabled || !objectActivationEnabled} value={createConfirmation} onChange={event=>setCreateConfirmation(event.target.value)} placeholder="DELIVER APPROVED REPORT" autoComplete="off"/></label>
        <button className="primary" onClick={createInSap} disabled={!objectCreateEnabled || !objectActivationEnabled || createBusy || selectionTextsMissing || !approvalId || !createName.trim() || !createDescription.trim() || !deliveryToken.trim() || createConfirmation !== "DELIVER APPROVED REPORT" || (packageName.toUpperCase() !== "$TMP" && (!packageName.trim() || !transportRequest))}>{createBusy ? "Creating, activating, and verifying…" : "Create, activate & assign approved report"}</button>
      </div>
      {transportError && packageName.toUpperCase() !== "$TMP" && <div className="error">{transportError}</div>}
      {approvalId && <small className="live-context-muted">Selected approval: {approvalId}. Delivery uses only this approved saved source and its approved labels; the editor below is a preview and syntax-check copy.</small>}
      {selectionTextsMissing && <div className="syntax-result failure"><div className="syntax-result-head"><AlertTriangle size={16}/><b>This older approved draft has selection fields but no approved label section. SAP create and activation are blocked until a version with approved labels is ready.</b></div><button className="secondary" onClick={prepareSelectionTexts} disabled={prepareBusy}>{prepareBusy ? "Preparing review draft…" : "Prepare selection labels for approval"}</button>{prepareMessage && <p>{prepareMessage}</p>}</div>}
      {createError && <div className="error">{createError}</div>}
      {createResult && <div className={`syntax-result ${createResult.ok === false ? "failure" : "success"}`}><div className="syntax-result-head">{createResult.ok === false ? <AlertTriangle size={16}/> : <CheckCircle2 size={16}/>}<b>{createResult.message}</b></div>{(createResult.activation?.state?.startsWith("activation-") || createResult.selectionTexts?.activation?.state?.startsWith("activation-") || createResult.state?.startsWith("activation-")) && <p>JDAP checks SAP’s inactive-object list before reporting activation as successful. Resolve the inactive status in SAP before retrying.</p>}{(createResult.sapSyntaxCheck || createResult.syntaxCheck) && <div className="sap-syntax-summary"><b>{(createResult.sapSyntaxCheck || createResult.syntaxCheck).message}</b>{(createResult.sapSyntaxCheck || createResult.syntaxCheck).messages?.length > 0 && <ul>{(createResult.sapSyntaxCheck || createResult.syntaxCheck).messages.map((item, index) => <li key={`${item.code}-${item.line}-${index}`}><code>{item.severity}{item.line ? ` · line ${item.line}` : ""}</code> {item.message}</li>)}</ul>}</div>}</div>}
      <small className="live-context-muted">The delivery token authorizes this approved report creation/finalization and activation. JDAP checks SAP syntax, activates the approved source first, then saves, activates, and verifies the approved labels. New object and text-pool changes use the selected Workbench request. If a later SAP step fails, JDAP reports exactly what completed; it never releases or imports the request.</small>
    </section>
    <section className="panel testing-panel">
      <div className="panelhead"><div><span className="eyebrow">ABAP QUALITY GATE</span><h2>Syntax and release check</h2></div><ShieldCheck size={20} className="testing-icon"/></div>
      <p className="testing-copy">Run an offline ABAP grammar check against the selected SAP_BASIS release. This catches parser-level syntax issues before review.</p>
      <div className="testing-toolbar"><label htmlFor="abapRelease">Target release</label><select id="abapRelease" value={release} onChange={e => setRelease(e.target.value)}><option value="v750">SAP_BASIS 7.50 · ECC EHP8 / NetWeaver 7.5</option><option value="v740sp08">SAP_BASIS 7.40 SP08</option><option value="v740sp05">SAP_BASIS 7.40 SP05</option><option value="v740sp02">SAP_BASIS 7.40 SP02</option><option value="v702">SAP_BASIS 7.02</option><option value="v751">SAP_BASIS 7.51</option><option value="v752">SAP_BASIS 7.52</option><option value="v753">SAP_BASIS 7.53</option><option value="v754">SAP_BASIS 7.54</option><option value="v755">SAP_BASIS 7.55</option><option value="v756">SAP_BASIS 7.56</option><option value="v757">SAP_BASIS 7.57</option><option value="v758">SAP_BASIS 7.58</option></select><button className="primary" onClick={checkSyntax} disabled={busy || !source.trim()}><Play size={14}/>{busy ? "Checking…" : "Check ABAP syntax"}</button></div>
      <label className="testing-label" htmlFor="abapSource">ABAP source {sourceOrigin && <span>{sourceOrigin}</span>}</label>
      <textarea id="abapSource" className="syntax-editor" value={source} onChange={e => setSource(e.target.value)} spellCheck="false" placeholder="Paste or edit an ABAP report here…" />
      {error && <div className="error">{error}</div>}
      {result && <div className={`syntax-result ${result.state === "grammar-ok" ? "success" : "failure"}`}>
        <div className="syntax-result-head">{result.state === "grammar-ok" ? <CheckCircle2 size={16}/> : <AlertTriangle size={16}/>}<b>{result.message}</b><span>{result.lineCount} lines · {result.release.toUpperCase()}</span></div>
        {result.issues.length > 0 && <ul>{result.issues.map((issue, index) => <li key={`${issue.line}-${index}`}><code>Line {issue.line}:{issue.column}</code> {issue.message}</li>)}</ul>}
      </div>}
    </section>
    <section className="panel testing-boundary"><b>Validation boundary</b><p>This local check validates ABAP grammar only. It cannot verify SAP Dictionary fields and types, custom objects, authorization behavior, ATC checks, or runtime results. Use SAP’s own syntax check in the development system before activation.</p></section>
  </div>;
}
