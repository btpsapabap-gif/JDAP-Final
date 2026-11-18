import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, FileCode2, FilePlus2, FolderOpen, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import "../studio.css";

function extractSource(content = "") {
  return content.match(/```abap\s*([\s\S]*?)```/i)?.[1]?.trim() || "";
}

function programName(source = "") {
  return source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z][A-Z0-9_]*)/im)?.[1]?.toUpperCase() || "JDAP_DRAFT";
}

export default function CodeStudio({ systems = [], onViewHistory = () => {} }) {
  const [workflows, setWorkflows] = useState([]);
  const [studioDrafts, setStudioDrafts] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [studioDraftId, setStudioDraftId] = useState("");
  const [artifact, setArtifact] = useState(null);
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [approvalSystemId, setApprovalSystemId] = useState("mock-s4");
  const [preparingApproval, setPreparingApproval] = useState(false);
  const [preparedApproval, setPreparedApproval] = useState(null);
  const fileInput = useRef(null);

  async function refreshWorkflows() {
    setBusy(true); setError("");
    try {
      const [workflowResponse, studioResponse] = await Promise.all([fetch("/api/workflows"), fetch("/api/code-studio/drafts")]);
      const [workflowData, studioData] = await Promise.all([workflowResponse.json(), studioResponse.json()]);
      if (!workflowResponse.ok) throw new Error(workflowData.error || "Could not load saved workflow drafts.");
      if (!studioResponse.ok) throw new Error(studioData.error || "Could not load saved Code Studio drafts.");
      const available = Array.isArray(workflowData) ? workflowData.filter(item => item.artifact_id) : [];
      setStudioDrafts(Array.isArray(studioData) ? studioData : []);
      setWorkflows(available);
      if (!available.some(item => item.id === selectedId) && !artifact?.local) {
        setArtifact(null); setSource(""); setSavedSource(""); setStudioDraftId("");
        setSelectedId(available[0]?.id || "");
      }
      if (!available.length && !artifact?.local) { setArtifact(null); setSource(""); setSavedSource(""); setSelectedId(""); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function loadArtifact(workflowId) {
    const workflow = workflows.find(item => item.id === workflowId);
    if (!workflow) return;
    setLoadingSource(true); setError(""); setNotice(""); setStudioDraftId("");
    try {
      const response = await fetch(`/api/artifacts/${workflow.artifact_id}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load this saved draft.");
      const code = extractSource(data.content || "");
      setArtifact({ ...data, workflow });
      setSource(code); setSavedSource(code);
      if (!code) setError("This workflow has no ABAP source block to open in Code Studio.");
    } catch (e) { setArtifact(null); setSource(""); setSavedSource(""); setError(e.message); }
    finally { setLoadingSource(false); }
  }

  async function loadStudioDraft(id) {
    if (!id) return;
    setLoadingSource(true); setError(""); setNotice(""); setSelectedId("");
    try {
      const response = await fetch(`/api/code-studio/drafts/${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load this Code Studio draft.");
      setStudioDraftId(data.id); setArtifact({ title: data.title, local: true, workflow: { id: "local" } }); setPreparedApproval(null);
      setSource(data.source || ""); setSavedSource(data.source || "");
      setNotice(`Loaded ${data.title} from JDAP.`);
    } catch (e) { setError(e.message); }
    finally { setLoadingSource(false); }
  }

  useEffect(() => { refreshWorkflows(); }, []);
  useEffect(() => { if (selectedId && workflows.length) loadArtifact(selectedId); }, [selectedId, workflows]);

  const changed = source !== savedSource;
  const lines = useMemo(() => source ? source.split(/\r?\n/) : [], [source]);

  async function copySource() {
    try {
      await navigator.clipboard.writeText(source);
      setNotice("Source copied to clipboard.");
    } catch { setError("Clipboard access was blocked. Select the source and copy it manually."); }
  }

  function startNewSource() {
    const starter = "REPORT z_jdap_new_report.\n\n";
      setSelectedId(""); setStudioDraftId(""); setArtifact({ title: "New local ABAP source", local: true, workflow: { id: "local" } }); setPreparedApproval(null);
    setSource(starter); setSavedSource(starter); setError(""); setNotice("New local source started. It will not be saved to JDAP unless you download it.");
  }

  async function openAbapFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("Choose an ABAP file smaller than 2 MB."); return; }
    try {
      const text = await file.text();
      setSelectedId(""); setStudioDraftId(""); setArtifact({ title: file.name, local: true, workflow: { id: "local file" } }); setPreparedApproval(null);
      setSource(text); setSavedSource(text); setError(""); setNotice(`Opened ${file.name}. Your edits stay in this page until you download them.`);
    } catch { setError("Could not read this file. Choose a plain-text .abap file."); }
  }

  async function saveDraft() {
    if (!source.trim()) return;
    setSaving(true); setError(""); setNotice("");
    const title = artifact?.local ? artifact.title : `${programName(source)}.abap`;
    try {
      const response = await fetch(studioDraftId ? `/api/code-studio/drafts/${encodeURIComponent(studioDraftId)}` : "/api/code-studio/drafts", {
        method: studioDraftId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || `${programName(source)}.abap`, source })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save this Code Studio draft.");
      setStudioDraftId(data.id); setSavedSource(data.source); setArtifact({ title: data.title, local: true, workflow: { id: "local" } }); setSelectedId(""); setPreparedApproval(null);
      setPreparedApproval(null);
      setStudioDrafts(items => [data, ...items.filter(item => item.id !== data.id)].slice(0, 100));
      setNotice(`Saved ${data.title} in JDAP. The original workflow draft, if any, is unchanged.`);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function prepareApprovalDraft() {
    if (!studioDraftId || changed || !approvalSystemId) return;
    setPreparingApproval(true); setError(""); setNotice(""); setPreparedApproval(null);
    try {
      const response = await fetch(`/api/code-studio/drafts/${encodeURIComponent(studioDraftId)}/prepare-approval`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemId: approvalSystemId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not prepare this source for approval.");
      setPreparedApproval(data);
      setNotice(data.message);
    } catch (e) { setError(e.message); }
    finally { setPreparingApproval(false); }
  }

  function downloadSource() {
    const blob = new Blob([source.endsWith("\n") ? source : `${source}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${programName(source)}.abap`; link.click();
    URL.revokeObjectURL(url);
    setNotice(`Downloaded ${programName(source)}.abap.`);
  }

  return <div className="studio-page">
    <section className="panel studio-panel">
      <div className="panelhead"><div><span className="eyebrow">ABAP DRAFT WORKSPACE</span><h2>Code Studio</h2></div><div className="studio-head-actions"><button className="secondary" onClick={startNewSource} disabled={changed}><FilePlus2 size={14}/>New source</button><button className="secondary" onClick={() => fileInput.current?.click()} disabled={changed}><FolderOpen size={14}/>Open .abap</button><button className="secondary" onClick={refreshWorkflows} disabled={busy}><RefreshCw size={14}/>{busy ? "Refreshing…" : "Refresh drafts"}</button><input ref={fileInput} className="studio-file-input" type="file" accept=".abap,text/plain" onChange={openAbapFile}/></div></div>
      <p className="studio-note">Write ABAP here, open a local `.abap` file, or load a saved workflow draft. Copy or download your source when ready. Editing does not change the saved draft or SAP.</p>
      {error && <div className="error">{error}</div>}
      {notice && <div className={`studio-notice${preparedApproval?.qualityGate?.state === "BLOCKED" ? " blocked" : ""}`}><Check size={14}/>{notice}</div>}
      <div className="studio-toolbar">
        <label>Saved Code Studio draft<select value={studioDraftId} onChange={event => loadStudioDraft(event.target.value)} disabled={busy || loadingSource || changed || !studioDrafts.length}><option value="">Choose a saved Code Studio draft</option>{studioDrafts.map(item => <option key={item.id} value={item.id}>{item.title} · {new Date(item.updated_at).toLocaleString()}</option>)}</select></label>
        <label>Workflow draft<select value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={busy || loadingSource || changed || !workflows.length}><option value="">Choose a saved workflow</option>{workflows.map(item => <option key={item.id} value={item.id}>{String(item.prompt || "Saved ABAP draft").slice(0, 100)} · {new Date(item.created_at).toLocaleString()}</option>)}</select></label>
        <span className={`studio-state ${changed ? "edited" : ""}`}>{changed ? "Edited · unsaved" : studioDraftId ? "Saved in JDAP" : artifact?.local ? "Local source · unsaved" : artifact ? "Workflow draft · original unchanged" : "No source selected"}</span>
      </div>
      {loadingSource && <p className="historyempty">Loading ABAP source…</p>}
      {!busy && !loadingSource && !workflows.length && !studioDrafts.length && <p className="historyempty">No saved drafts yet. Start a source or generate a draft in AI Developer.</p>}
      {artifact && (source || artifact.local) && <>
        <div className="studio-artifact-meta"><FileCode2 size={15}/><strong>{programName(source)}.abap</strong><span>{artifact.title || "Saved development draft"}</span><span>{artifact.local ? "Local only" : `Workflow ${artifact.workflow.id.slice(0, 8)}`}</span></div>
        <div className="studio-editor-wrap"><div className="studio-gutter" aria-hidden="true">{lines.map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea aria-label="ABAP source editor" className="studio-editor" value={source} onChange={event => { setSource(event.target.value); setNotice(""); setPreparedApproval(null); }} spellCheck="false" /></div>
        <div className="studio-footer"><span>{lines.length} lines · {source.length.toLocaleString()} characters</span><div><button className="secondary" onClick={() => { setSource(savedSource); setNotice("Restored the source from the saved draft."); }} disabled={!changed}><RotateCcw size={14}/>Restore saved source</button><button className="primary" onClick={saveDraft} disabled={!source.trim() || saving || (Boolean(studioDraftId) && !changed)}><Check size={14}/>{saving ? "Saving…" : studioDraftId ? "Save changes" : "Save to JDAP"}</button><button className="secondary" onClick={copySource} disabled={!source.trim()}><Copy size={14}/>Copy source</button><button className="secondary" onClick={downloadSource} disabled={!source.trim()}><Download size={14}/>Download .abap</button></div></div>
        <div className="studio-approval">
          <div><span className="eyebrow">REVIEW AND APPROVAL</span><h3>Prepare a separate approval draft</h3><p>This copies the saved source into Workflow History and runs JDAP’s offline ABAP grammar and quality checks. The Code Studio source remains unchanged; nothing is sent to SAP.</p></div>
          <label>Target SAP profile<select value={approvalSystemId} onChange={event => setApprovalSystemId(event.target.value)} disabled={preparingApproval || !systems.length}>{systems.map(system => <option key={system.id} value={system.id}>{system.name} · {system.release}</option>)}</select></label>
          <button className="primary" onClick={prepareApprovalDraft} disabled={!studioDraftId || changed || preparingApproval || !systems.length || Boolean(preparedApproval)}><ShieldCheck size={14}/>{preparingApproval ? "Preparing…" : preparedApproval ? "Approval draft prepared" : "Prepare approval draft"}</button>
          {!studioDraftId && <small>Save this source to JDAP first. Unsaved or local-only edits cannot be sent for approval.</small>}
          {changed && studioDraftId && <small>Save your edits first. The approval draft uses only the currently saved Code Studio version.</small>}
          {preparedApproval && <button className="secondary" onClick={onViewHistory}>Open Workflow History to request approval</button>}
        </div>
      </>}
      <div className="studio-boundary">“Save to JDAP” stores this source as its own Code Studio draft. Preparing an approval draft creates a separate workflow artifact with the selected release’s offline grammar check. Request approval from Workflow History; approval does not change SAP.</div>
    </section>
  </div>;
}
