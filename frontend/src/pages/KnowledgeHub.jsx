import React, { useEffect, useMemo, useState } from "react";
import { BookOpen, Search, FileText, ArrowUpRight, RefreshCw } from "lucide-react";

const DOMAIN_LABELS = {
  abap: "ABAP",
  cds: "CDS",
  rap: "RAP",
  odata: "OData",
  "sap-standards": "SAP standards"
};

function ArticleBody({ content }) {
  const blocks = String(content || "").split(/\n\s*\n/);
  return <div className="knowledge-article-body">{blocks.map((block, index) => {
    const lines = block.split(/\r?\n/);
    const heading = lines[0].match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const Tag = `h${heading[1].length + 1}`;
      return <Tag key={index}>{heading[2]}</Tag>;
    }
    if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
      return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{line.replace(/^\s*[-*]\s+/, "")}</li>)}</ul>;
    }
    return <p key={index}>{lines.map((line, lineIndex) => <React.Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line}</React.Fragment>)}</p>;
  })}</div>;
}

export default function KnowledgeHub() {
  const [items, setItems] = useState([]);
  const [domains, setDomains] = useState([]);
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("all");
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true); setError("");
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (domain !== "all") params.set("domain", domain);
        const response = await fetch(`/api/knowledge?${params}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load the Knowledge Hub.");
        setItems(data.items || []); setDomains(data.domains || []);
        setSelected(current => current && (data.items || []).some(item => item.id === current.id) ? current : null);
      } catch (e) { if (e.name !== "AbortError") setError(e.message); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, domain]);

  async function openArticle(item) {
    setSelected({ ...item, loading: true });
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(item.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open this guidance.");
      setSelected(data);
    } catch (e) { setError(e.message); setSelected(null); }
  }

  const grouped = useMemo(() => domains.map(key => ({ key, label: DOMAIN_LABELS[key] || key })), [domains]);

  return <div className="knowledge-page">
    <section className="panel knowledge-intro">
      <div className="panelhead"><div><div className="eyebrow">LOCAL REFERENCE</div><h2>Engineering knowledge</h2></div><BookOpen className="knowledge-icon" size={22} /></div>
      <p>Browse JDAP working guidance for ABAP, CDS, RAP, OData, and SAP standards. These notes support review; verify SAP release contracts, authorizations, and system behavior in the target landscape.</p>
      <div className="knowledge-boundary">Local guidance only. No external documentation is indexed, and these notes do not certify SAP compliance.</div>
    </section>
    <div className="knowledge-toolbar">
      <label className="knowledge-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search titles and guidance" aria-label="Search knowledge" /></label>
      <div className="knowledge-filters"><button className={domain === "all" ? "active" : ""} onClick={() => setDomain("all")}>All</button>{grouped.map(item => <button key={item.key} className={domain === item.key ? "active" : ""} onClick={() => setDomain(item.key)}>{item.label}</button>)}</div>
    </div>
    {error && <div className="knowledge-error">{error}</div>}
    <div className="knowledge-layout">
      <section className="panel knowledge-results" aria-label="Knowledge articles">
        <div className="knowledge-results-head"><b>{busy ? "Loading guidance…" : `${items.length} ${items.length === 1 ? "guide" : "guides"}`}</b>{busy && <RefreshCw size={14} className="knowledge-spin" />}</div>
        {!busy && items.length === 0 && <p className="knowledge-empty">No guidance matches this search.</p>}
        {items.map(item => <button key={item.id} className={`knowledge-card ${selected?.id === item.id ? "selected" : ""}`} onClick={() => openArticle(item)}>
          <FileText size={16} /><span><small>{DOMAIN_LABELS[item.domain] || item.domain}</small><b>{item.title}</b><em>{item.summary}</em></span><ArrowUpRight size={14} />
        </button>)}
      </section>
      <section className="panel knowledge-detail" aria-label="Selected guidance">
        {!selected && <div className="knowledge-placeholder"><BookOpen size={25} /><b>Choose a guide</b><span>Guidance will open here.</span></div>}
        {selected?.loading && <div className="knowledge-placeholder"><RefreshCw className="knowledge-spin" size={20} /><span>Loading guide…</span></div>}
        {selected && !selected.loading && <>
          <div className="knowledge-article-head"><div><div className="eyebrow">{DOMAIN_LABELS[selected.domain] || selected.domain}</div><h2>{selected.title}</h2><p>{selected.summary}</p></div>{selected.updated && <small>Updated {selected.updated}</small>}</div>
          <div className="knowledge-source">{selected.sourceName || "JDAP working guidance"}{selected.sourceUrl && <> · <a href={selected.sourceUrl} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={11} /></a></>}</div>
          <ArticleBody content={selected.content} />
        </>}
      </section>
    </div>
  </div>;
}
