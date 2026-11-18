import React from "react";
import { Activity, Bot, Boxes, BookOpen, CheckCircle2, Code2, Database, GitBranch, History, LayoutDashboard, MessageSquare, ShieldCheck, Terminal } from "lucide-react";

const navigation = [
  ["Overview",LayoutDashboard],["AI Developer",MessageSquare],["My Projects",Boxes],["Agent Workforce",Bot],
  ["Workflow History",Activity],["SAP Systems",Database],["Code Studio",Code2],["Debug Center",Terminal],
  ["Testing Center",ShieldCheck],["Knowledge Hub",BookOpen],["Git & Transports",GitBranch],
  ["Approvals",CheckCircle2],["Audit & Analytics",History]
];

export default function Sidebar({ page, onNavigate, agentCount, aiProvider, sapState, adtState }) {
  const sapLabel = `OData ${(sapState || "checking").replaceAll("-", " ")} · ADT ${(adtState || "checking").replaceAll("-", " ")}`;
  return <aside className="sidebar">
    <div className="brand"><div className="brandmark">J</div><div><b>JDAP</b><small>DEVELOPER AGENT PLATFORM</small></div></div>
    <div className="workspace"><span className={`dot ${adtState === "reachable" || sapState === "reachable" ? "green" : ""}`}></span><div><b>Local Workspace</b><small>{sapLabel}</small></div><span>›</span></div>
    <div className="navlabel">WORKSPACE</div>
    {navigation.map(([label,Icon])=><button key={label} className={"navitem "+(page===label?"active":"")} onClick={()=>onNavigate(label)}><Icon size={17}/><span>{label}</span>{label==="Agent Workforce"&&<em>{agentCount}</em>}</button>)}
    <div className="sidebarbottom"><div className="user"><div className="avatar">D</div><div><b>Developer</b><small>Local session</small></div><span className="online"></span></div><small className="version">JDAP v1.1 · AI: {(aiProvider||"mock").toUpperCase()} · ODATA: {(sapState||"checking").replaceAll("-"," ").toUpperCase()} · ADT: {(adtState||"checking").replaceAll("-"," ").toUpperCase()}</small></div>
  </aside>;
}
