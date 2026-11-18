import React from "react";
import { Cpu } from "lucide-react";

export default function ModulePlaceholder({ page, agents, systems }) {
  return <div className="panel placeholder"><div className="placeholdericon"><Cpu size={28}/></div><h2>{page}</h2><p>This module is registered in the JDAP navigation. The runnable MVP currently provides the AI Developer workflow, workflow history, agent registry, mock SAP systems, artifact generation and audit API. Additional module screens are planned for subsequent releases.</p></div>;
}
