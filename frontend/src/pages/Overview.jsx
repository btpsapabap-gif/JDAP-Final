import React, { useEffect, useMemo, useState } from "react";
import { Activity, ArrowRight, Bot, CheckCircle2, Clock3, FolderKanban, Play, RefreshCw, ShieldCheck, Workflow, XCircle } from "lucide-react";
import "../overview.css";

function stateClass(value = "") { return String(value).toLowerCase().replaceAll("_", "-"); }

export default function Overview({ health, agents = [], systems = [], sapConnection, adtConnection, onNavigate = () => {} }) {
  const [workflows, setWorkflows] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setBusy(true); setError("");
    try {
      const responses = await Promise.all([fetch("/api/workflows"), fetch("/api/approvals"), fetch("/api/projects")]);
      const data = await Promise.all(responses.map(response => response.json()));
      const failed = responses.findIndex(response => !response.ok);
      if (failed >= 0) throw new Error(data[failed]?.error || "Could not refresh workspace summary.");
      setWorkflows(Array.isArray(data[0]) ? data[0] : []);
      setApprovals(Array.isArray(data[1]) ? data[1] : []);
      setProjects(Array.isArray(data[2]) ? data[2] : []);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => { refresh(); }, []);

  const counts = useMemo(() => ({
    completed: workflows.filter(item => item.status === "COMPLETED").length,
    running: workflows.filter(item => item.status === "RUNNING").length,
    failed: workflows.filter(item => item.status === "FAILED").length,
    pending: approvals.filter(item => item.status === "PENDING").length
  }), [workflows, approvals]);

  const recent = workflows.slice(0, 6);
  const statusItems = [
    ["Database", health?.database || "checking"],
    ["SAP OData", sapConnection?.state || "checking"],
    ["SAP ADT", adtConnection?.state || "checking"],
    ["AI provider", health?.aiProvider || "mock"]
  ];

  return <div className="overview-page">
    <section className="overview-welcome">
      <div><span className="eyebrow">JDAP WORKSPACE</span><h2>Engineering overview</h2><p>See recent development activity, approval work, and connected service status.</p></div>
      <button className="secondary" onClick={refresh} disabled={busy}><RefreshCw size={14}/>{busy ? "Refreshing…" : "Refresh"}</button>
    </section>
    {error && <div className="error">{error}</div>}
    <section className="overview-stats">
      <article><span className="overview-icon violet"><Workflow size={17}/></span><div><small>Recent workflows</small><strong>{workflows.length}</strong><span>Latest 100 maximum</span></div></article>
      <article><span className="overview-icon green"><CheckCircle2 size={17}/></span><div><small>Completed</small><strong>{counts.completed}</strong><span>In the loaded history</span></div></article>
      <article><span className="overview-icon amber"><Clock3 size={17}/></span><div><small>Approvals waiting</small><strong>{counts.pending}</strong><span>Local review queue</span></div></article>
      <article><span className="overview-icon blue"><FolderKanban size={17}/></span><div><small>Projects</small><strong>{projects.length}</strong><span>Local workspaces</span></div></article>
    </section>
    <div className="overview-grid">
      <section className="panel overview-recent">
        <div className="panelhead"><div><span className="eyebrow">RECENT ACTIVITY</span><h3>Workflow history</h3></div><button className="textbutton" onClick={() => onNavigate("Workflow History")}>View all <ArrowRight size={13}/></button></div>
        {busy && !workflows.length ? <p className="historyempty">Loading recent workflows…</p> : recent.length ? <div className="overview-workflows">{recent.map(item => <button key={item.id} className="overview-workflow" onClick={() => onNavigate("Workflow History")}><span className={`overview-workflow-state ${stateClass(item.status)}`}>{item.status === "COMPLETED" ? <CheckCircle2 size={14}/> : item.status === "FAILED" ? <XCircle size={14}/> : <Activity size={14}/>}</span><span className="overview-workflow-copy"><b>{item.artifact_title || item.prompt || "Development workflow"}</b><small>{item.system_id || "SAP profile"} · {new Date(item.created_at).toLocaleString()}</small></span><span className="overview-workflow-badge">{item.quality_gate_state?.replaceAll("_", " ") || item.status}</span></button>)}</div> : <p className="historyempty">No workflows yet. Start a development task to see activity here.</p>}
        {counts.running + counts.failed > 0 && <div className="overview-live-note">{counts.running > 0 && <span><Activity size={13}/>{counts.running} running</span>}{counts.failed > 0 && <span><XCircle size={13}/>{counts.failed} failed</span>}</div>}
      </section>
      <section className="panel overview-side">
        <div className="panelhead"><div><span className="eyebrow">WORKSPACE SERVICES</span><h3>Connection status</h3></div><span className={`overview-health-dot ${health?.status === "ok" && health?.database === "connected" ? "online" : ""}`}/></div>
        <div className="overview-status-list">{statusItems.map(([label, value]) => <div key={label}><span>{label}</span><b className={stateClass(value)}>{String(value).replaceAll("_", " ").toUpperCase()}</b></div>)}</div>
        <p className="overview-boundary">Connection indicators describe reachability/configuration only. They do not confirm SAP source access, syntax, activation, or Clean Core compliance.</p>
        <div className="overview-quick"><span className="eyebrow">QUICK ACCESS</span><button onClick={() => onNavigate("AI Developer")}><Play size={14}/>Start a development task</button><button onClick={() => onNavigate("Approvals")}><ShieldCheck size={14}/>Review draft approvals</button><button onClick={() => onNavigate("Code Studio")}><Bot size={14}/>Open Code Studio</button></div>
      </section>
    </div>
    <div className="overview-foot">Configured specialists: {agents.length} · SAP profiles: {systems.length} · SAP operations remain separately gated.</div>
  </div>;
}
