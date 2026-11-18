import React from "react";
import { Bot, Server, ShieldCheck, Workflow } from "lucide-react";

export default function StatsGrid({ agentCount, systemCount }) {
  return <div className="stats">
    <div className="stat"><div className="stat-icon purple"><Bot/></div><div><small>Specialist agents</small><strong>{agentCount||"—"}</strong><span>Ready to collaborate</span></div></div>
    <div className="stat"><div className="stat-icon blue"><Server/></div><div><small>SAP environments</small><strong>{systemCount||"—"}</strong><span>Mock profiles configured</span></div></div>
    <div className="stat"><div className="stat-icon greenbg"><Workflow/></div><div><small>Orchestration</small><strong>Multi-agent</strong><span>Context-aware handoffs</span></div></div>
    <div className="stat"><div className="stat-icon orange"><ShieldCheck/></div><div><small>Execution policy</small><strong>Approval-first</strong><span>No SAP write access</span></div></div>
  </div>;
}
