import React from "react";
import { ChevronRight } from "lucide-react";

export default function Topbar({ page, database, aiProvider, sapState, adtState }) {
  return <header className="topbar">
    <div className="crumb">Workspace <ChevronRight size={14}/> <b>{page}</b></div>
    <div className="topright"><span className="system-pill"><span className="dot green"></span> {database==="connected"?"Database connected":"Connecting database"}</span><span className="mode-pill">AI: {(aiProvider||"mock").toUpperCase()}</span><span className="mode-pill">ODATA: {(sapState||"checking").replaceAll("-"," ").toUpperCase()}</span><span className="mode-pill">ADT: {(adtState||"checking").replaceAll("-"," ").toUpperCase()}</span><span className="mode-pill">DEV: {adtState==="reachable"?"ADT READ":"MOCK"}</span><div className="avatar small">D</div></div>
  </header>;
}
