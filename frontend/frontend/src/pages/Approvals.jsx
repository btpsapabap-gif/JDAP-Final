import React, { useEffect, useState } from "react";
import { CheckCircle2, Clock3, XCircle } from "lucide-react";

export default function Approvals() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/approvals");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load approvals.");
      setItems(data);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => { refresh(); }, []);

  async function decide(item, decision) {
    const reviewNote = window.prompt(decision === "APPROVED"
      ? "Approval note. For ABAP, record the SAP Clean Core ATC result, released API/release-contract evidence, or extension-point evidence:"
      : "Rejection note (optional):", "");
    if (reviewNote === null) return;
    try {
      const response = await fetch(`/api/approvals/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, reviewNote }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save review.");
      await refresh();
    } catch (e) { setError(e.message); }
  }

  async function downloadHandoff(item) {
    try {
      const response = await fetch(`/api/approvals/${item.id}/handoff`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Could not download the approved handoff.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `jdap-approved-handoff-${item.artifact_id.slice(0, 8)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  }

  return <div className="approvals-page">
    <section className="panel approvals-panel">
      <div className="panelhead"><div><span className="eyebrow">CONTROLLED DELIVERY</span><h2>Draft approval queue</h2></div><span className="count">{items.filter(item => item.status === "PENDING").length} pending</span></div>
      <p className="approval-boundary">Local review records only. Approval does not create, activate, transport, or send an object to SAP.</p>
      {error && <div className="error">{error}</div>}
      {busy ? <p className="historyempty">Loading approval queue…</p> : items.length === 0 ? <p className="historyempty">No drafts are waiting for review. Request approval from a saved draft in Workflow History.</p> : <div className="approval-list">{items.map(item => <article className="approval-card" key={item.id}>
        <div className="approval-title"><div><span className="eyebrow">{item.artifact_type || "DRAFT"} · {item.status}</span><h3>{item.artifact_title}</h3></div><small>{new Date(item.created_at).toLocaleString()}</small></div>
        <p className="approval-prompt">{item.workflow_prompt || "Saved development artifact"}</p>
        {item.request_note && <p className="approval-note"><b>Request:</b> {item.request_note}</p>}
        {item.review_note && <p className="approval-note"><b>Review:</b> {item.review_note}</p>}
        <details><summary>Review draft content</summary><pre>{item.artifact_content}</pre></details>
        {item.status === "PENDING" && <div className="approval-actions"><button className="secondary" onClick={()=>decide(item,"REJECTED")}><XCircle size={14}/> Reject draft</button><button className="primary" onClick={()=>decide(item,"APPROVED")}><CheckCircle2 size={14}/> Approve draft</button></div>}
        {item.status === "PENDING" && <small className="approval-pending"><Clock3 size={12}/> Awaiting local review</small>}
        {item.status !== "PENDING" && <small className={`approval-decision ${item.status.toLowerCase()}`}>{item.status} by {item.reviewed_by || "Local reviewer"}</small>}
        {item.status === "APPROVED" && <div className="approval-actions"><button className="secondary" onClick={()=>downloadHandoff(item)}>Download approved handoff</button></div>}
      </article>)}</div>}
    </section>
  </div>;
}
