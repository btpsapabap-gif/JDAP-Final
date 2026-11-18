import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, GitBranch, Github, RefreshCw } from "lucide-react";

export default function GitTransports() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubWriteToken, setGithubWriteToken] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState("");
  const [repository, setRepository] = useState(null);
  const [approvedDrafts, setApprovedDrafts] = useState([]);
  const [approvedDraftsError, setApprovedDraftsError] = useState("");
  const [approvalId, setApprovalId] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branchName, setBranchName] = useState("");
  const [filePath, setFilePath] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("JDAP approved ABAP draft. Review the source and run repository checks before merging.");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [prPreview, setPrPreview] = useState(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createResult, setCreateResult] = useState(null);
  const [prConfirmation, setPrConfirmation] = useState("");

  useEffect(() => {
    fetch("/api/git/approved-drafts").then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load approved JDAP drafts.");
      setApprovedDrafts(data.drafts || []);
    }).catch(error => setApprovedDraftsError(error.message));
  }, []);

  async function loadRequests() {
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/sap/adt/transports", { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.state || "Could not read SAP transport requests.");
      setResult(data);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function readRepository() {
    setGitBusy(true); setGitError(""); setRepository(null);
    try {
      const response = await fetch("/api/git/repository/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl, token: githubToken })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.state || "Could not read the GitHub repository.");
      setRepository(data);
      setBaseBranch(data.repository.defaultBranch || data.branches[0]?.name || "");
      clearPrPreview();
    } catch (e) { setGitError(e.message); }
    finally { setGitBusy(false); }
  }

  function clearPrPreview() { setPrPreview(null); setCreateResult(null); setCreateError(""); setPrConfirmation(""); }

  function selectDraft(id) {
    const draft = approvedDrafts.find(item => item.approvalId === id);
    setApprovalId(id);
    setFilePath(draft ? `abap/${draft.programName}.abap` : "");
    setBranchName(draft ? `jdap/${draft.programName.toLowerCase()}-${id.slice(0, 8)}` : "");
    setPrTitle(draft ? `Approved ABAP: ${draft.programName}` : "");
    setPreviewError("");
    clearPrPreview();
  }

  function pullRequestPayload() {
    return { approvalId, repositoryUrl, token: githubToken, baseBranch, branchName, filePath, title: prTitle, body: prBody };
  }

  async function previewPullRequest() {
    setPreviewBusy(true); setPreviewError(""); setPrPreview(null); setCreateResult(null); setCreateError("");
    try {
      const response = await fetch("/api/git/pull-requests/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pullRequestPayload()) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.state || "Could not preview the approved source change.");
      setPrPreview(data);
    } catch (error) { setPreviewError(error.message); }
    finally { setPreviewBusy(false); }
  }

  async function createDraftPullRequest() {
    if (!prPreview) return;
    setCreateBusy(true); setCreateError(""); setCreateResult(null);
    try {
      const response = await fetch("/api/git/pull-requests/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...pullRequestPayload(), token: githubWriteToken, expectedBaseCommitSha: prPreview.baseCommitSha, expectedFileSha: prPreview.fileSha, expectedSourceSha256: prPreview.sourceSha256, confirmation: prConfirmation })
      });
      const data = await response.json();
      if (!response.ok && !data.branchCreated) throw new Error(data.message || data.state || "Could not create the GitHub draft pull request.");
      setCreateResult(data);
      if (!response.ok) setCreateError(data.message || data.state || "GitHub created part of the change; review the reported branch before retrying.");
    } catch (error) { setCreateError(error.message); }
    finally { setCreateBusy(false); }
  }

  return <div className="testing-page">
    <section className="panel">
      <div className="panelhead"><div><span className="eyebrow">SAP CHANGE AND TRANSPORT SYSTEM</span><h2>Transport requests</h2></div><GitBranch size={20} className="testing-icon"/></div>
      <p className="testing-copy">Read the transport requests available to your SAP ADT user. This first transport milestone is read-only: JDAP does not assign an object, create a request, release, or import a transport.</p>
      <div className="testing-toolbar transport-read-toolbar">
        <label>JDAP read token<input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Configured SAP_ADT_READ_API_TOKEN" autoComplete="off"/></label>
        <button className="primary" onClick={loadRequests} disabled={busy || !token.trim()}><RefreshCw size={14}/>{busy ? "Loading SAP requests…" : "Load transport requests"}</button>
      </div>
      <small className="live-context-muted">The token is used for this request and is not saved in JDAP. SAP permissions determine which requests are visible.</small>
      {error && <div className="error">{error}</div>}
      {result && <div className="syntax-result success">
        <div className="syntax-result-head"><CheckCircle2 size={16}/><b>{result.message}</b><span>{result.transport}</span></div>
        {result.requests?.length ? <div className="transport-table-wrap"><table className="transport-table"><thead><tr><th>Request</th><th>Description</th><th>Owner</th><th>Status</th><th>Type</th></tr></thead><tbody>{result.requests.map((request, index) => <tr key={`${request.id}-${index}`}><td><code>{request.id}</code></td><td>{request.description || "—"}</td><td>{request.owner || "—"}</td><td>{request.status || "—"}</td><td>{request.type || "—"}</td></tr>)}</tbody></table></div> : <p>SAP ADT returned no transport requests for this SAP user.</p>}
        <small>{result.note}</small>
      </div>}
    </section>
      <section className="panel testing-boundary"><b>Create into a Workbench request</b><p>In Testing Center, select a saved approved draft, choose a transportable package, load the modifiable Workbench requests with your JDAP read token, then choose the intended request before confirming creation. JDAP assigns the new object during creation; existing objects are not moved. Request release and import remain manual SAP activities.</p></section>
    <section className="panel">
      <div className="panelhead"><div><span className="eyebrow">READ-ONLY SOURCE CONTROL</span><h2>GitHub repository preview</h2></div><Github size={20} className="testing-icon"/></div>
      <p className="testing-copy">Inspect repository details, branches, and recent commits, then prepare a pull request from an approved ABAP draft. JDAP shows the exact diff first; creating a branch, commit, and draft pull request requires a separate confirmation.</p>
      <div className="testing-toolbar transport-read-toolbar">
        <label>GitHub repository URL<input value={repositoryUrl} onChange={event=>{setRepositoryUrl(event.target.value);setRepository(null);clearPrPreview()}} placeholder="https://github.com/owner/repository" autoComplete="url"/></label>
        <label>GitHub token <span className="live-context-muted">(optional for public preview)</span><input type="password" value={githubToken} onChange={event=>{setGithubToken(event.target.value);clearPrPreview()}} placeholder="Fine-grained token; write permissions are only needed to create a PR" autoComplete="off"/></label>
        <button className="primary" onClick={readRepository} disabled={gitBusy || !repositoryUrl.trim()}><RefreshCw size={14}/>{gitBusy ? "Reading repository…" : "Read repository"}</button>
      </div>
      <small className="live-context-muted">The token is sent to JDAP for the request only and is not stored. Preview needs read access; creating a draft PR needs repository contents write and pull-requests write permissions.</small>
      {gitError && <div className="error">{gitError}</div>}
      {repository && <div className="syntax-result success">
        <div className="syntax-result-head"><CheckCircle2 size={16}/><b>{repository.repository.name}</b><span>{repository.repository.private ? "Private" : "Public"} · default branch {repository.repository.defaultBranch || "—"}</span><a href={repository.repository.htmlUrl} target="_blank" rel="noreferrer" aria-label="Open repository on GitHub"><ExternalLink size={14}/></a></div>
        {repository.repository.description && <p>{repository.repository.description}</p>}
        <div className="git-preview-grid">
          <div><h3>Branches ({repository.branches.length})</h3>{repository.branches.length ? <ul>{repository.branches.map(branch=><li key={branch.name}><code>{branch.name}</code> <small>{branch.sha.slice(0, 7)}</small></li>)}</ul> : <p>No branches returned.</p>}</div>
          <div><h3>Recent commits ({repository.commits.length})</h3>{repository.commits.length ? <ul>{repository.commits.map(commit=><li key={commit.sha}><code>{commit.shortSha}</code> {commit.message}<small>{commit.author}{commit.date ? ` · ${new Date(commit.date).toLocaleString()}` : ""}</small></li>)}</ul> : <p>No commits returned.</p>}</div>
        </div>
        <small>{repository.note}</small>
      </div>}
    </section>
    <section className="panel">
      <div className="panelhead"><div><span className="eyebrow">APPROVAL-GATED DELIVERY</span><h2>Prepare an approved ABAP pull request</h2></div><GitBranch size={20} className="testing-icon"/></div>
      <p className="testing-copy">Choose a currently approved JDAP artifact, repository, base branch, and matching <code>.abap</code> file path. Review the generated diff before any GitHub write. The final action creates a <b>draft</b> pull request and does not merge it.</p>
      <div className="git-delivery-grid">
        <label>Approved JDAP ABAP draft<select value={approvalId} onChange={event=>selectDraft(event.target.value)}><option value="">Choose an approved draft</option>{approvedDrafts.map(draft=><option key={draft.approvalId} value={draft.approvalId}>{draft.programName} · {draft.title} · {draft.approvalId.slice(0,8)}</option>)}</select></label>
        <label>Repository<input value={repositoryUrl} onChange={event=>{setRepositoryUrl(event.target.value);setRepository(null);clearPrPreview()}} placeholder="Read a GitHub repository above"/></label>
        <label>Base branch<select value={baseBranch} onChange={event=>{setBaseBranch(event.target.value);clearPrPreview()}} disabled={!repository?.branches?.length}><option value="">Choose a base branch</option>{(repository?.branches || []).map(branch=><option key={branch.name} value={branch.name}>{branch.name}</option>)}</select></label>
        <label>Feature branch<input value={branchName} onChange={event=>{setBranchName(event.target.value);clearPrPreview()}} placeholder="jdap/report-name-approval-id"/></label>
        <label>ABAP file path<input value={filePath} onChange={event=>{setFilePath(event.target.value);clearPrPreview()}} placeholder="abap/Z_REPORT_NAME.abap"/></label>
        <label>Pull request title<input value={prTitle} onChange={event=>{setPrTitle(event.target.value);clearPrPreview()}} maxLength={250}/></label>
      </div>
      <label className="git-pr-body-label">Pull request description<textarea value={prBody} onChange={event=>{setPrBody(event.target.value);clearPrPreview()}} maxLength={6000}/></label>
      {approvedDraftsError && <div className="error">{approvedDraftsError}</div>}
      <div className="testing-toolbar"><button className="primary" onClick={previewPullRequest} disabled={previewBusy || !approvalId || !repository || !baseBranch || !branchName || !filePath || !prTitle}>{previewBusy ? "Preparing diff…" : "Preview approved source diff"}</button></div>
      {previewError && <div className="error">{previewError}</div>}
      {prPreview && <div className="syntax-result success">
        <div className="syntax-result-head"><CheckCircle2 size={16}/><b>Diff preview · {prPreview.repository}</b><span>{prPreview.baseBranch} → {prPreview.branchName}</span></div>
        <p>{prPreview.artifactTitle} · {prPreview.filePath} · +{prPreview.changedLines.added} / −{prPreview.changedLines.removed} lines</p>
        {!prPreview.branchAvailable && <p className="git-warning"><AlertTriangle size={14}/> This feature branch already exists. Choose a new branch name and preview again.</p>}
        <pre className="git-diff">{prPreview.diff}</pre>
        <small>{prPreview.note} Preview is tied to the shown base-branch commit and destination-file version; changes on GitHub make it stale.</small>
        {prPreview.branchAvailable && <div className="git-write-confirm">
          <label>GitHub PR write token<input type="password" value={githubWriteToken} onChange={event=>setGithubWriteToken(event.target.value)} placeholder="Contents: write · Pull requests: write" autoComplete="off"/><small className="live-context-muted">Used only for this request; not stored by JDAP.</small></label>
          <label>Type CREATE DRAFT PULL REQUEST to confirm<input value={prConfirmation} onChange={event=>setPrConfirmation(event.target.value)} placeholder="CREATE DRAFT PULL REQUEST" autoComplete="off"/></label>
          <button className="primary" onClick={createDraftPullRequest} disabled={createBusy || !githubWriteToken.trim() || prConfirmation !== "CREATE DRAFT PULL REQUEST"}>{createBusy ? "Creating draft pull request…" : "Create branch, commit & draft pull request"}</button>
        </div>}
      </div>}
      {createError && <div className="error">{createError}</div>}
      {createResult && <div className={`syntax-result ${createResult.ok ? "success" : "failure"}`}>
        <div className="syntax-result-head">{createResult.ok ? <CheckCircle2 size={16}/> : <AlertTriangle size={16}/>}<b>{createResult.message}</b></div>
        <div className="git-result-links">{createResult.pullRequestUrl && <a href={createResult.pullRequestUrl} target="_blank" rel="noreferrer">Open draft pull request <ExternalLink size={13}/></a>}{createResult.branchUrl && <a href={createResult.branchUrl} target="_blank" rel="noreferrer">Open feature branch <ExternalLink size={13}/></a>}{createResult.commitUrl && <a href={createResult.commitUrl} target="_blank" rel="noreferrer">Open source commit <ExternalLink size={13}/></a>}</div>
      </div>}
      <small className="live-context-muted">Tokens remain in this page's memory for the current session only. JDAP writes only to the new <code>jdap/</code> feature branch and opens a draft pull request; the base branch is unchanged and no merge is performed.</small>
    </section>
    <section className="panel testing-boundary"><b>Git delivery boundary</b><p>Only a current approved JDAP ABAP artifact can be sent. JDAP rechecks approval and the diff's base/file versions before writing. A partial GitHub response can leave a branch or commit behind; JDAP reports that state and does not delete repository data automatically.</p></section>
  </div>;
}
