import React from "react";
import { Bot } from "lucide-react";

export default function AgentCards({ agents }) {
  return <div className="agentcards">{agents.map(a=><div className="agentcard" key={a.id}><Bot size={18}/><b>{a.name}</b><span>{a.specialty}</span><small>{a.description}</small></div>)}</div>;
}
