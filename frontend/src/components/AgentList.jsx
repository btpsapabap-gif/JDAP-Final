import React from "react";
import { Bot, ChevronRight } from "lucide-react";

export default function AgentList({ agents, onViewAll }) {
  return <div className="panel workforce">
    <div className="panelhead"><div><span className="eyebrow">AVAILABLE WORKFORCE</span><h2>Specialist agents</h2></div><span className="count">{agents.length} ACTIVE</span></div>
    <div className="agentlist">{agents.map(a=><div className="agentrow" key={a.id}><div className="agenticon"><Bot size={16}/></div><div className="agenttext"><b>{a.name}</b><small>{a.specialty}</small></div><span className="ready">READY</span></div>)}</div>
    <button className="textbutton" onClick={onViewAll}>View agent registry <ChevronRight size={14}/></button>
  </div>;
}
