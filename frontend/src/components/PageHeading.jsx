import React from "react";

export default function PageHeading({ page, database, sapState }) {
  const isSap = page === "SAP Systems";
  const label = isSap ? `ODATA ${sapState || "CHECKING"}` : database === "connected" ? "API · DATABASE OPERATIONAL" : "CHECKING SERVICES";
  const stateClass = isSap && sapState !== "reachable" ? "live warn" : "live";
  const descriptions = { "Audit & Analytics": "Review local workflow, approval, and SAP delivery events.", "Code Studio": "Open, edit, and export ABAP drafts from your saved workflows.", "Debug Center": "Analyze SAP errors with the focused debugging specialist." };
  const description = descriptions[page] || "Coordinate specialist agents to design, generate and validate SAP development drafts.";
  return <div className="heading"><div><div className="eyebrow">AI-POWERED SAP ENGINEERING</div><h1>{page==="AI Developer"?"Developer command center":page}</h1><p>{description}</p></div><div className="heading-actions"><span className={stateClass}><i/> {label}</span></div></div>;
}
