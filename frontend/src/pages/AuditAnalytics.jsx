import React, { useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw, Search } from "lucide-react";
import "../audit.css";

function detailsValue(details) {
  if (details && typeof details === "object") return details;
  if (typeof details === "string") {
    try { return JSON.parse(details); } catch { return { value: details }; }
  }
  return {};
}

export default function AuditAnalytics() {
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [eventFilter, setEventFilter] = useState("ALL");

  async function refresh() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/audit");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load audit events.");
      setEvents(Array.isArray(data) ? data : []);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => { refresh(); }, []);

  const eventTypes = useMemo(() => [...new Set(events.map(item => item.event).filter(Boolean))].sort(), [events]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter(item => {
      if (eventFilter !== "ALL" && item.event !== eventFilter) return false;
      if (!needle) return true;
      const text = [item.event, item.workflow_id, JSON.stringify(detailsValue(item.details))].join(" ").toLowerCase();
      return text.includes(needle);
    });
  }, [events, eventFilter, query]);
  const workflowCount = new Set(events.map(item => item.workflow_id).filter(Boolean)).size;

  return <div className="audit-page">
    <section className="panel audit-panel">
      <div className="panelhead">
        <div><span className="eyebrow">GOVERNANCE · LOCAL RECORDS</span><h2>Audit &amp; Analytics</h2></div>
        <button className="secondary audit-refresh" onClick={refresh} disabled={busy}><RefreshCw size={14}/>{busy ? "Refreshing…" : "Refresh"}</button>
      </div>
      <p className="audit-boundary">Review the latest 100 recorded JDAP events. This view is read-only; it does not change approvals, SAP objects, transports, or GitHub.</p>
      {error && <div className="error">{error}</div>}
      <div className="audit-metrics">
        <article><span>Events loaded</span><strong>{events.length}</strong></article>
        <article><span>Event types</span><strong>{eventTypes.length}</strong></article>
        <article><span>Workflows represented</span><strong>{workflowCount}</strong></article>
      </div>
      <div className="audit-filters">
        <label className="audit-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search event, workflow, or details"/></label>
        <label className="audit-event-filter"><span>Event type</span><select value={eventFilter} onChange={event => setEventFilter(event.target.value)}><option value="ALL">All event types</option>{eventTypes.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
        <small>{filtered.length} shown · up to 100 latest events</small>
      </div>
      {busy && events.length === 0 ? <p className="historyempty">Loading audit history…</p> : filtered.length === 0 ? <div className="audit-empty"><Activity size={20}/><p>{events.length ? "No events match these filters." : "No audit events have been recorded yet."}</p></div> : <div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Time</th><th>Event</th><th>Workflow</th><th>Details</th></tr></thead><tbody>{filtered.map((item, index) => {
        const details = detailsValue(item.details);
        return <tr key={item.id || `${item.created_at}-${index}`}><td className="audit-time">{item.created_at ? new Date(item.created_at).toLocaleString() : "—"}</td><td><span className="audit-event-tag">{item.event || "Unknown event"}</span></td><td><code>{item.workflow_id || "—"}</code></td><td><details className="audit-detail"><summary>View details</summary><pre>{JSON.stringify(details, null, 2)}</pre></details></td></tr>;
      })}</tbody></table></div>}
    </section>
  </div>;
}
