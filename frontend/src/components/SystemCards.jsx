import React from "react";
import { Database } from "lucide-react";

export default function SystemCards({ systems }) {
  return <div className="systemcards">{systems.map(s=><div className="systemcard" key={s.id}><Database/><b>{s.name}</b><span>{s.release}</span><small>{s.capabilities.join(" · ")}</small><em>MOCK ONLY</em></div>)}</div>;
}
