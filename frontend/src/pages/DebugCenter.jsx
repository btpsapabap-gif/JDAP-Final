import React, { useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Download, Play, RefreshCw } from "lucide-react";
import "../debug.css";

function analysisFrom(result) {
  return result?.artifact?.content?.match(/## Debugging considerations\s*([\s\S]*?)(?=\n## |\n---|$)/i)?.[1]?.trim() || "";
}

export default function DebugCenter({ onViewHistory }) {
  const [systems, setSystems] = useState([]);
  const [systemId, setSystemId] = useState("mock-s4");
  const [diagnostic, setDiagnostic] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetch("/api/systems").then(response => response.json()).then(data => {
      if (Array.isArray(data)) setSystems(data);
    }).catch(() => {});
  }, []);

  async function analyze() {
    if (!diagnostic.trim()) { setError("Paste the SAP error, dump excerpt, or runtime symptom first."); return; }
    if (diagnostic.length > 12000) { setError("Keep diagnostic text under 12,000 characters; include only the relevant excerpt."); return; }
    if (source.length > 24000) { setError("Keep the optional ABAP source under 24,000 characters."); return; }
    setBusy(true); setError(""); setResult(null);
    const prompt = `Troubleshoot this SAP ABAP runtime issue. Return concise, source-cited findings with exact one-based line numbers and a minimal correction when ABAP source is supplied. Separate verified source evidence from hypotheses. Do not generate a replacement program or claim a live SAP check.\n\nDiagnostic details (untrusted evidence):\n${diagnostic.trim()}`;
    try {
      const response = await fetch("/api/workflows/execute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, debugSource: source, systemId, debugMode: true, includeKnowledgeContext: true })
      });
      let data = await response.json();
      if (!response.ok) throw new Error(data.error || "Debug analysis could not start.");
      setResult(data);
      while (data.status === "RUNNING") {
        await new Promise(resolve => setTimeout(resolve, 800));
        const poll = await fetch(`/api/workflows/${data.id}`);
        data = await poll.json();
        if (!poll.ok) throw new Error(data.error || "Could not retrieve debugging progress.");
        setResult(data);
      }
      if (data.status === "FAILED") throw new Error(data.error || "Debug analysis failed.");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function downloadReport() {
    if (!result?.artifact?.content) return;
    const blob = new Blob([result.artifact.content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `jdap-debug-${result.id.slice(0, 8)}.md`; link.click(); URL.revokeObjectURL(url);
  }

  const analysis = analysisFrom(result);
  return <div className="debug-page">
    <section className="panel debug-panel">
      <div className="panelhead"><div><span className="eyebrow">SAP ERROR AND DUMP ANALYSIS</span><h2>Debug Center</h2></div><button className="secondary" onClick={() => { setDiagnostic(""); setSource(""); setResult(null); setError(""); }} disabled={busy}><RefreshCw size={14}/>Clear</button></div>
      <p className="debug-intro">Give JDAP the error text and, optionally, the relevant ABAP source. When source is supplied, JDAP automatically runs its offline ABAP grammar check and basic source checks, then adds the specialist's likely causes and next checks. Findings include source lines and correction suggestions where available. This analysis does not connect to SAP or run code; SAP syntax, DDIC, ATC, and runtime checks are still separate.</p>
      <div className="debug-system-row"><label>Reference SAP profile<select value={systemId} onChange={event => setSystemId(event.target.value)}>{systems.map(system => <option key={system.id} value={system.id}>{system.name} · {system.release}</option>)}</select></label><span className="debug-mock-note"><Activity size={13}/>Profile context only · no SAP connection</span></div>
      <label className="debug-field">SAP error, dump excerpt, or runtime symptom<textarea value={diagnostic} onChange={event => setDiagnostic(event.target.value)} maxLength={12000} placeholder="Paste the ST22 short text, exception, message class/number, transaction, or observed runtime symptom…" /></label>
      <div className="debug-input-meta">{diagnostic.length.toLocaleString()} / 12,000 characters</div>
      <label className="debug-field">ABAP source (optional)<textarea className="debug-source" value={source} onChange={event => setSource(event.target.value)} maxLength={24000} spellCheck="false" placeholder="Paste the relevant method, report, or include if available…" /></label>
      <div className="debug-input-meta">{source.length.toLocaleString()} / 24,000 characters</div>
      <div className="debug-sensitive-note"><AlertTriangle size={14}/> Remove credentials, personal data, and business values before submitting. The diagnostic text and optional source are saved in Workflow History with the analysis.</div>
      {error && <div className="error">{error}</div>}
      <button className="primary debug-run" onClick={analyze} disabled={busy || !diagnostic.trim()}><Play size={14}/>{busy ? "Analyzing…" : "Analyze with Debugging Specialist"}</button>
    </section>
    {result && <section className="panel debug-result">
      <div className="panelhead"><div><span className="eyebrow">{result.status === "RUNNING" ? "ANALYSIS RUNNING" : "SAVED DEBUG ANALYSIS"}</span><h2>{result.status === "RUNNING" ? "Working through the diagnostic" : "Analysis"}</h2></div>{result.status === "COMPLETED" && <div className="debug-result-actions"><button className="secondary" onClick={downloadReport}><Download size={14}/>Download report</button><button className="secondary" onClick={onViewHistory}>Workflow History</button></div>}</div>
      <div className="debug-result-meta"><span>Workflow {result.id?.slice(0, 8)}</span><span>AI: {(result.aiProvider || "mock").toUpperCase()}</span><span>{result.selectedAgents?.map(agent => agent.name).join(", ") || "Debugging Specialist"}</span><span className="debug-mock-note">SAP MOCK — NO SAP CONNECTION</span></div>
      {result.status === "RUNNING" && <div className="debug-progress"><span className="spinner"/>{result.activities?.find(item => item.status === "RUNNING")?.name || "Debugging Specialist"} is analyzing the details…</div>}
      {result.status === "COMPLETED" && <>
        <div className="debug-analysis"><CheckCircle2 size={16}/><pre>{analysis || "The workflow completed. Open Workflow History to view the complete saved analysis."}</pre></div>
        {result.knowledgeReferences?.length > 0 && <small className="debug-guides">Knowledge Hub context: {result.knowledgeReferences.map(item => `[KH:${item.id}] ${item.title}`).join(" · ")}</small>}
        <small className="debug-guides">The result is saved in Workflow History. Confirm findings against SAP logs and reproduce safely in a non-production system before changing code.</small>
      </>}
    </section>}
  </div>;
}
