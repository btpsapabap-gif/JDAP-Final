import React from "react";
import AgentDirectory from "../agents/AgentDirectory.jsx";

export default function AgentWorkforce({ agents }) {
  return <div className="panel workforce-page">
    <div className="panelhead"><div><span className="eyebrow">SPECIALIST REGISTRY</span><h2>JDAP agent workforce</h2></div><span className="count">{agents.length} REGISTERED</span></div>
    <p className="historyempty">These specialist profiles are orchestrated for each request. In mock mode their responses are simulated; OpenAI mode uses the configured model. No agent has live SAP access.</p>
    <AgentDirectory agents={agents}/>
  </div>;
}
