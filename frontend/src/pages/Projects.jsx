import React, { useEffect, useMemo, useState } from "react";
import { FolderKanban, Plus, RefreshCw, Search, Workflow } from "lucide-react";
import "../projects.css";

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [unassigned, setUnassigned] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setBusy(true); setError("");
    try {
      const [projectResponse, workflowResponse] = await Promise.all([fetch("/api/projects"), fetch("/api/projects/unassigned-workflows")]);
      const [projectData, workflowData] = await Promise.all([projectResponse.json(), workflowResponse.json()]);
      if (!projectResponse.ok) throw new Error(projectData.error || "Could not load projects.");
      if (!workflowResponse.ok) throw new Error(workflowData.error || "Could not load completed workflows.");
      setProjects(projectData);
      setUnassigned(workflowData);
      setSelectedId(current => projectData.some(item => item.id === current) ? current : projectData[0]?.id || "");
      setWorkflowId(current => workflowData.some(item => item.id === current) ? current : workflowData[0]?.id || "");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => { refresh(); }, []);

  const selected = projects.find(item => item.id === selectedId) || null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter(item => !needle || `${item.name} ${item.description}`.toLowerCase().includes(needle));
  }, [projects, query]);

  async function createProject(event) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create project.");
      setName(""); setDescription(""); setSelectedId(data.id); setNotice(`Created project “${data.name}”.`);
      await refresh();
      setSelectedId(data.id);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function assignWorkflow(event) {
    event.preventDefault();
    if (!selected || !workflowId) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/projects/${selected.id}/workflows/${workflowId}`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not add workflow to project.");
      setNotice("Completed workflow added to this project. Its source and approval status were not changed.");
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return <div className="projects-page">
    <section className="panel projects-panel">
      <div className="panelhead"><div><span className="eyebrow">WORK ORGANIZATION</span><h2>My Projects</h2></div><button className="secondary" onClick={refresh} disabled={busy}><RefreshCw size={14}/>{busy ? "Refreshing…" : "Refresh"}</button></div>
      <p className="projects-boundary">Group completed JDAP workflows by project. Adding a workflow changes only its project association; it does not edit the draft, approval, SAP object, transport, or GitHub.</p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="projects-notice">{notice}</div>}
      <div className="projects-create">
        <form onSubmit={createProject}>
          <h3><Plus size={15}/>Create a project</h3>
          <label>Project name<input value={name} onChange={event => setName(event.target.value)} maxLength={120} placeholder="e.g. Billing modernization" required/></label>
          <label>Description <span>(optional)</span><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} placeholder="Business goal, SAP scope, or delivery notes"/></label>
          <button className="primary" type="submit" disabled={saving || !name.trim()}>{saving ? "Saving…" : "Create project"}</button>
        </form>
      </div>
      <div className="projects-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search projects"/></div>
      {busy && projects.length === 0 ? <p className="historyempty">Loading projects…</p> : <div className="projects-layout">
        <div className="projects-list"><div className="projects-count">{filtered.length} project{filtered.length === 1 ? "" : "s"}</div>{filtered.length ? filtered.map(project => <button key={project.id} className={`project-row${project.id === selectedId ? " selected" : ""}`} onClick={() => setSelectedId(project.id)}><FolderKanban size={17}/><span><b>{project.name}</b><small>{project.workflow_count} workflow{project.workflow_count === 1 ? "" : "s"}</small></span></button>) : <p className="historyempty">No matching projects. Create one above.</p>}</div>
        <section className="project-detail">{selected ? <>
          <div className="project-detail-head"><div><span className="eyebrow">PROJECT</span><h3>{selected.name}</h3><p>{selected.description || "No description added."}</p></div><span className="project-count"><Workflow size={14}/>{selected.workflow_count} workflows</span></div>
          {unassigned.length > 0 && <form className="project-assign" onSubmit={assignWorkflow}><label>Add a completed workflow<select value={workflowId} onChange={event => setWorkflowId(event.target.value)}>{unassigned.map(item => <option key={item.id} value={item.id}>{String(item.prompt || "Saved workflow").slice(0, 90)} · {new Date(item.created_at).toLocaleString()}</option>)}</select></label><button className="secondary" type="submit" disabled={saving || !workflowId}>{saving ? "Adding…" : "Add workflow"}</button></form>}
          <div className="project-workflows"><h4>Workflows</h4>{selected.workflows?.length ? selected.workflows.map(item => <article key={item.id} className="project-workflow"><div><b>{item.artifactTitle || item.prompt || "Saved workflow"}</b><small>{item.systemId || "SAP profile unavailable"} · {new Date(item.createdAt).toLocaleString()}</small></div><span className="project-status">{item.status}{item.qualityGateState ? ` · ${item.qualityGateState.replaceAll("_", " ")}` : ""}</span></article>) : <p className="historyempty">No workflows assigned yet. Add one from the completed workflow list above.</p>}</div>
        </> : <div className="projects-empty"><FolderKanban size={24}/><b>Select or create a project</b><span>Projects keep related workflow drafts together.</span></div>}</section>
      </div>}
      {!busy && unassigned.length === 0 && <small className="projects-footnote">No unassigned completed workflows are available.</small>}
    </section>
  </div>;
}
