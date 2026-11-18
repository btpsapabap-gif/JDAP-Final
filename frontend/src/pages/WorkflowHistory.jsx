import React from "react";
import { CheckCircle2, ChevronRight, Download, FileCode2 } from "lucide-react";

export default function WorkflowHistory({ workflows, busy, error, selected, onOpen, onDownload, onRequestApproval }) {
  return <>
    <div className="panel historypanel">
      <div className="panelhead"><div><span className="eyebrow">PERSISTED WORK</span><h2>Recent workflows</h2></div><span className="count">{workflows.length} / 100</span></div>
      {busy?<p className="historyempty">Loading workflow history…</p>:error?<div className="error">{error}</div>:workflows.length===0?<p className="historyempty">No workflows saved yet. Run a task in AI Developer to build history.</p>:<div className="historylist">{workflows.map(w=>{const completed=(w.activities||[]).filter(a=>a.status==="COMPLETED").length;return <button className={"historyrow "+(selected?.id===w.id?"selected":"")} key={w.id} onClick={()=>onOpen(w)} disabled={!w.artifact_id} title={w.artifact_id?"Open saved draft":"No draft was saved for this workflow"}><span className="historystatus">{w.status}</span><span className="historybody"><b>{w.prompt}</b><small>{new Date(w.created_at).toLocaleString()} · {w.system_id} · AI: {(w.ai_provider||"unknown").toUpperCase()} · {completed}/{(w.activities||[]).length} agents complete</small></span><ChevronRight size={16}/></button>})}</div>}
    </div>
    {selected&&<div className="panel results">
      <div className="panelhead"><div><span className="eyebrow">SAVED DEVELOPMENT DRAFT</span><h2>{selected.artifact.title}</h2></div><div className="historyactions"><button className="secondary" onClick={onDownload}><Download size={15}/> Download draft</button><button className="primary" onClick={()=>onRequestApproval(selected.artifact.id)} disabled={selected.quality_gate_state === "BLOCKED"} title={selected.quality_gate_state === "BLOCKED" ? "Resolve the blocking quality findings before requesting approval." : "Request approval for this saved draft."}>Request approval</button></div></div>
      <div className="resultmeta"><span>Workflow {selected.id.slice(0,8)}</span><span>AI: {(selected.ai_provider||"unknown").toUpperCase()}</span><span className="mockwarning">SAP MOCK — NO SAP CONNECTION</span></div>
      {selected.activities?.length>0&&<div className="activitygrid">{selected.activities.map(a=><div className="activity" key={a.agentId}>{a.status==="FAILED"?<span className="agentfailed">!</span>:<CheckCircle2 size={15}/>}<div><b>{a.name}</b><small>{a.status==="COMPLETED"?`${a.durationMs} ms · completed`:a.status}</small></div></div>)}</div>}
      <div className="artifact"><div className="artifacthead"><FileCode2 size={17}/> Saved draft <span>MARKDOWN</span></div><pre>{selected.artifact.content}</pre></div>
    </div>}
  </>;
}
