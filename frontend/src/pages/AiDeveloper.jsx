import React from "react";
import { CheckCircle2, Download, FileCode2, RefreshCw, Server } from "lucide-react";
import AgentList from "../agents/AgentList.jsx";
import StatsGrid from "../dashboard/StatsGrid.jsx";
import TaskComposer from "../chat/TaskComposer.jsx";

export default function AiDeveloper({ agents, systems, systemId, setSystemId, prompt, setPrompt, busy, run, error, canRetryMock, result, aiProvider, sapState, sapTransport, sapEntitySet, includeSapContext, setIncludeSapContext, includeKnowledgeContext, setIncludeKnowledgeContext, referenceWorkflowId, setReferenceWorkflowId, workflows, onViewAgents, onDownload, onResumeFailedWorkflow }) {
  return <>
    <StatsGrid agentCount={agents.length} systemCount={systems.length}/>
    <div className="workgrid">
      <TaskComposer systems={systems} systemId={systemId} setSystemId={setSystemId} prompt={prompt} setPrompt={setPrompt} busy={busy} run={run} error={error} canRetryMock={canRetryMock} aiProvider={aiProvider} sapState={sapState} sapTransport={sapTransport} sapEntitySet={sapEntitySet} includeSapContext={includeSapContext} setIncludeSapContext={setIncludeSapContext} includeKnowledgeContext={includeKnowledgeContext} setIncludeKnowledgeContext={setIncludeKnowledgeContext} referenceWorkflowId={referenceWorkflowId} setReferenceWorkflowId={setReferenceWorkflowId} workflows={workflows}/>
      <AgentList agents={agents} onViewAll={onViewAgents}/>
    </div>
    {result&&<div className="panel results">
      <div className="panelhead"><div><span className="eyebrow">WORKFLOW {result.status} · {result.activities.filter(a=>a.status==="COMPLETED").length}/{result.selectedAgents?.length||result.activities.length||12} SELECTED AGENTS</span><h2>{result.status==="RUNNING"?"Agent progress":"Development result"}</h2></div><div className="historyactions">{result.retryable&&result.status==="FAILED"&&<button className="secondary" onClick={()=>onResumeFailedWorkflow?.(result.id)} disabled={busy}><RefreshCw size={14}/>{busy?"Resuming failed agent…":"Resume from failed agent"}</button>}{result.artifact&&<button className="secondary" onClick={onDownload}><Download size={15}/> Download draft</button>}</div></div>
      <div className="resultmeta"><span><CheckCircle2 size={15}/> Workflow {result.id.slice(0,8)}</span><span><Server size={15}/> {result.system?.name||"Mock SAP target"}</span><span>AI: {(result.aiProvider||aiProvider||"mock").toUpperCase()}</span><span className="mockwarning">{result.sapConnectivity === "LIVE ODATA READ ONLY" ? "LIVE ODATA CONTEXT · READ ONLY" : "SAP MOCK — NO SAP CONNECTION"}</span></div>
      {result.referenceWorkflowId&&<div className="resultmeta"><span>Reused approved JDAP draft from workflow {result.referenceWorkflowId.slice(0,8)}</span></div>}
      {result.generationMode==="CURATED_S4_BILLING_TEMPLATE"&&<div className="resultmeta"><span>ABAP source generated from JDAP's curated S/4 billing template; Ollama did not generate the source.</span></div>}
      {result.knowledgeReferences?.length>0&&<div className="resultmeta knowledge-citations"><span>Knowledge Hub context: {result.knowledgeReferences.map(source=>`[KH:${source.id}] ${source.title}`).join(" · ")}</span></div>}
      {result.selectedAgents?.length>0&&<div className="resultmeta"><span>Selected for this task: {result.selectedAgents.map(agent=>agent.name).join(" · ")}</span></div>}
      {result.qualityGate&&<div className={`syntax-result ${result.qualityGate.state==="BLOCKED"||result.qualityGate.cleanCore?.status!=="VERIFIED_BY_SAP_ATC"?"failure":"success"}`}><div className="syntax-result-head"><b>Draft gate: {result.qualityGate.state.replaceAll("_"," ")}</b><span>ABAP grammar: {result.qualityGate.grammarState} · {result.qualityGate.grammarRelease}</span></div>{result.qualityGate.blockers?.length>0&&<ul>{result.qualityGate.blockers.map((item,index)=><li key={`${item.code}-${index}`}>{item.line?`Line ${item.line}: `:""}{item.message}</li>)}</ul>}<p>Clean Core: SAP ATC verification required. JDAP does not assign a Clean Core Level or claim compliance from offline checks.</p>{result.qualityGate.cleanCore?.findings?.filter(item=>item.code!=="clean-core-atc-required").map((item,index)=><p key={`${item.code}-${index}`}>{item.message}</p>)}</div>}
      {result.status==="RUNNING"&&<div className="progressnote"><span className="spinner"/> {result.activities.find(a=>a.status==="RUNNING")?.name||"Preparing agents"} is working. {result.aiProvider==="mock"?"Mock workflow is simulating specialist steps.":"Progress updates automatically."}</div>}
      {result.status==="FAILED"&&!result.retryable&&<div className="progressnote">This workflow has no saved resumable handoff. Start a new run; standard generation workflows now preserve completed specialist outputs for resume.</div>}
      <div className="activitygrid">{result.activities.map(a=><div className="activity" key={a.agentId}>{a.status==="RUNNING"?<span className="spinner"/>:a.status==="FAILED"?<span className="agentfailed">!</span>:<CheckCircle2 size={15}/>}<div><b>{a.name}</b><small>{a.status==="RUNNING"?"Working…":a.status==="FAILED"?"Failed":`${a.durationMs} ms · completed`}</small></div></div>)}</div>
      {result.artifact&&<div className="artifact"><div className="artifacthead"><FileCode2 size={17}/> Generated development draft <span>MARKDOWN</span></div><pre>{result.artifact.content}</pre></div>}
    </div>}
  </>;
}
