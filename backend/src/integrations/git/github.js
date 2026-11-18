import { createHash } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ABAP_SOURCE_BYTES = 200_000;

function parseRepositoryUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("Enter a valid GitHub repository URL, such as https://github.com/owner/repository."); }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("The read-only Git connector currently accepts HTTPS GitHub repository URLs only.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("Use a repository URL in the form https://github.com/owner/repository.");
  const [owner, rawName] = parts;
  const name = rawName.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
    throw new Error("The GitHub repository owner or name is invalid.");
  }
  return { owner, name };
}

function validateTarget({ baseBranch, branchName, filePath }) {
  const base = String(baseBranch || "").trim();
  const branch = String(branchName || "").trim();
  const path = String(filePath || "").trim().replace(/\\/g, "/");
  if (!base || base.length > 255 || base.startsWith("-") || /[\r\n\0]/.test(base)) throw new Error("Choose a valid base branch from the repository.");
  if (!/^jdap\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(branch) || branch.split("/").some(part => !part || part === "." || part === ".." || part.endsWith("."))) {
    throw new Error("Feature branches must use the jdap/ prefix and contain only safe branch-name characters.");
  }
  if (!path || path.length > 180 || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") || !/^[A-Za-z0-9._/-]+\.abap$/i.test(path)) {
    throw new Error("Choose a relative .abap file path without parent-directory segments.");
  }
  return { baseBranch: base, branchName: branch, filePath: path };
}

function apiPath(owner, name, subpath = "") {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${subpath}`;
}

function encodePathSegments(value) {
  return String(value).split("/").map(encodeURIComponent).join("/");
}

async function githubJson({ path, token, signal, fetchImpl, method = "GET", body, allow404 = false }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "JDAP-approved-draft-git-integration"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetchImpl(`${GITHUB_API}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal, redirect: "error" });
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw new Error("GitHub returned an oversized response; the operation was stopped.");
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { throw new Error(`GitHub returned an unexpected response (HTTP ${response.status}).`); }
  }
  if (allow404 && response.status === 404) return { data: null, status: 404 };
  if (!response.ok) {
    if (response.status === 401) throw new Error("GitHub rejected the token. Check the token and repository access.");
    if (response.status === 403) throw new Error("GitHub denied this permission or its API rate limit was reached. Check the token permissions.");
    if (response.status === 404) throw new Error("GitHub could not find the repository, branch, or file for the supplied access.");
    if (response.status === 409 || response.status === 422) throw new Error(`GitHub could not apply the change (HTTP ${response.status}). Check for an existing branch, conflicting file update, or invalid pull-request request.`);
    throw new Error(`GitHub request failed with HTTP ${response.status}.`);
  }
  return { data, status: response.status };
}

function makeUnifiedDiff(filePath, before, after) {
  const oldLines = before === "" ? [] : before.replace(/\r\n?/g, "\n").split("\n");
  const newLines = after.replace(/\r\n?/g, "\n").split("\n");
  if (oldLines.length > 1500 || newLines.length > 1500) throw new Error("This source is too large for the in-page diff preview (maximum 1,500 lines). No Git change was made.");
  const columns = newLines.length + 1;
  const lcs = new Uint32Array((oldLines.length + 1) * columns);
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const offset = i * columns + j;
      lcs[offset] = oldLines[i] === newLines[j]
        ? lcs[(i + 1) * columns + j + 1] + 1
        : Math.max(lcs[(i + 1) * columns + j], lcs[i * columns + j + 1]);
    }
  }
  const operations = [];
  let i = 0; let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) operations.push(` ${oldLines[i++]}`), j++;
    else if (j < newLines.length && (i === oldLines.length || lcs[i * columns + j + 1] >= lcs[(i + 1) * columns + j])) operations.push(`+${newLines[j++]}`);
    else operations.push(`-${oldLines[i++]}`);
  }
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  return {
    diff: [`diff --git a/${filePath} b/${filePath}`, `--- ${oldCount ? `a/${filePath}` : "/dev/null"}`, `+++ b/${filePath}`, `@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@`, ...operations].join("\n"),
    added: operations.filter(line => line.startsWith("+")).length,
    removed: operations.filter(line => line.startsWith("-")).length
  };
}

function abapDeclaration(source) {
  return source.match(/^\s*(?:REPORT|PROGRAM)\s+([A-Z0-9_]+)/im)?.[1]?.toUpperCase() || "";
}

async function getGitHubTarget({ repository, baseBranch, filePath, token, signal, fetchImpl }) {
  const repoPath = apiPath(repository.owner, repository.name);
  const repoResult = await githubJson({ path: repoPath, token, signal, fetchImpl });
  const branchRef = await githubJson({ path: `${repoPath}/git/ref/heads/${encodePathSegments(baseBranch)}`, token, signal, fetchImpl });
  const baseCommitSha = branchRef.data?.object?.sha;
  if (!baseCommitSha) throw new Error("GitHub did not return the selected base branch commit.");
  const contentsQuery = new URLSearchParams({ ref: baseBranch });
  const fileResult = await githubJson({ path: `${repoPath}/contents/${encodePathSegments(filePath)}?${contentsQuery}`, token, signal, fetchImpl, allow404: true });
  let fileSha = "";
  let before = "";
  if (fileResult.data) {
    const item = fileResult.data;
    if (item.type !== "file" || item.encoding !== "base64" || typeof item.content !== "string") throw new Error("The selected destination exists but is not a readable regular file.");
    if (Number(item.size || 0) > MAX_ABAP_SOURCE_BYTES) throw new Error("The existing destination file is larger than JDAP's 200 KB limit.");
    fileSha = item.sha || "";
    before = Buffer.from(item.content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (Buffer.byteLength(before, "utf8") > MAX_ABAP_SOURCE_BYTES) throw new Error("The existing destination file is larger than JDAP's 200 KB limit.");
  return { repo: repoResult.data, baseCommitSha, fileSha, before };
}

export async function previewGitHubPullRequest({ repositoryUrl, token, baseBranch, branchName, filePath, source }, fetchImpl = fetch) {
  let repository;
  let target;
  try {
    repository = parseRepositoryUrl(repositoryUrl);
    target = validateTarget({ baseBranch, branchName, filePath });
  } catch (error) { return { ok: false, status: 400, state: "invalid-git-target", message: error.message }; }
  const accessToken = String(token || "").trim();
  if (accessToken.length > 500) return { ok: false, status: 400, state: "invalid-token", message: "The GitHub token is too long." };
  if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source, "utf8") > MAX_ABAP_SOURCE_BYTES) return { ok: false, status: 422, state: "invalid-approved-source", message: "The approved ABAP source is empty or exceeds the 200 KB Git limit." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const current = await getGitHubTarget({ repository, baseBranch: target.baseBranch, filePath: target.filePath, token: accessToken, signal: controller.signal, fetchImpl });
    const branchPath = `${apiPath(repository.owner, repository.name)}/git/ref/heads/${encodePathSegments(target.branchName)}`;
    const existingBranch = await githubJson({ path: branchPath, token: accessToken, signal: controller.signal, fetchImpl, allow404: true });
    const sourceSha = createHash("sha256").update(source).digest("hex");
    const previewDiff = makeUnifiedDiff(target.filePath, current.before, source);
    return {
      ok: true,
      state: "pull-request-preview-ready",
      provider: "github",
      repository: current.repo.full_name,
      repositoryUrl: current.repo.html_url,
      private: Boolean(current.repo.private),
      defaultBranch: current.repo.default_branch,
      baseBranch: target.baseBranch,
      baseCommitSha: current.baseCommitSha,
      branchName: target.branchName,
      branchAvailable: !existingBranch.data,
      filePath: target.filePath,
      fileSha: current.fileSha,
      sourceSha256: sourceSha,
      diff: previewDiff.diff,
      changedLines: { added: previewDiff.added, removed: previewDiff.removed },
      note: "Preview only. No branch, commit, or pull request has been created. JDAP will require a separate confirmation before writing to GitHub."
    };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { ok: false, status: timeout ? 504 : 502, state: timeout ? "timeout" : "pull-request-preview-failed", message: timeout ? "GitHub diff preview timed out." : error.message };
  } finally { clearTimeout(timer); }
}

export async function createGitHubDraftPullRequest({ repositoryUrl, token, baseBranch, branchName, filePath, source, expectedBaseCommitSha, expectedFileSha, expectedSourceSha256, title, body }, fetchImpl = fetch) {
  let repository;
  let target;
  try {
    repository = parseRepositoryUrl(repositoryUrl);
    target = validateTarget({ baseBranch, branchName, filePath });
  } catch (error) { return { ok: false, status: 400, state: "invalid-git-target", message: error.message }; }
  const accessToken = String(token || "").trim();
  if (!accessToken) return { ok: false, status: 401, state: "github-write-token-required", message: "A GitHub token with repository contents write and pull-request write permissions is required." };
  if (accessToken.length > 500) return { ok: false, status: 400, state: "invalid-token", message: "The GitHub token is too long." };
  if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source, "utf8") > MAX_ABAP_SOURCE_BYTES) return { ok: false, status: 422, state: "invalid-approved-source", message: "The approved ABAP source is empty or exceeds the 200 KB Git limit." };
  if (!expectedBaseCommitSha || expectedSourceSha256 !== createHash("sha256").update(source).digest("hex")) return { ok: false, status: 409, state: "preview-required", message: "The approved source or preview has changed. Generate a fresh diff preview before creating the pull request." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let branchCreated = false;
  let commitUrl = "";
  let branchUrl = "";
  const repoPath = apiPath(repository.owner, repository.name);
  try {
    const current = await getGitHubTarget({ repository, baseBranch: target.baseBranch, filePath: target.filePath, token: accessToken, signal: controller.signal, fetchImpl });
    if (current.baseCommitSha !== expectedBaseCommitSha || current.fileSha !== (expectedFileSha || "")) return { ok: false, status: 409, state: "preview-stale", message: "The base branch or destination file changed after preview. Refresh the preview before creating the pull request." };
    const branchRef = await githubJson({ path: `${repoPath}/git/ref/heads/${encodePathSegments(target.branchName)}`, token: accessToken, signal: controller.signal, fetchImpl, allow404: true });
    if (branchRef.data) return { ok: false, status: 409, state: "branch-already-exists", message: `Branch ${target.branchName} already exists. Choose another jdap/ branch name and preview again.` };
    await githubJson({ path: `${repoPath}/git/refs`, token: accessToken, signal: controller.signal, fetchImpl, method: "POST", body: { ref: `refs/heads/${target.branchName}`, sha: current.baseCommitSha } });
    branchCreated = true;
    branchUrl = `${current.repo.html_url}/tree/${encodeURIComponent(target.branchName).replace(/%2F/gi, "/")}`;
    const contentBody = {
      message: String(title || `Add approved ABAP report ${abapDeclaration(source) || target.filePath}`).slice(0, 200),
      content: Buffer.from(source, "utf8").toString("base64"),
      branch: target.branchName,
      ...(current.fileSha ? { sha: current.fileSha } : {})
    };
    const saved = await githubJson({ path: `${repoPath}/contents/${encodePathSegments(target.filePath)}`, token: accessToken, signal: controller.signal, fetchImpl, method: "PUT", body: contentBody });
    commitUrl = saved.data?.commit?.html_url || "";
    const pull = await githubJson({ path: `${repoPath}/pulls`, token: accessToken, signal: controller.signal, fetchImpl, method: "POST", body: {
      title: String(title || `Approved ABAP: ${abapDeclaration(source) || target.filePath}`).slice(0, 250),
      body: String(body || "JDAP approved ABAP draft. Review the source and run repository checks before merging.").slice(0, 6000),
      head: target.branchName,
      base: target.baseBranch,
      draft: true
    } });
    return { ok: true, state: "draft-pull-request-created", repository: current.repo.full_name, branchName: target.branchName, branchUrl, filePath: target.filePath, commitSha: saved.data?.commit?.sha || "", commitUrl, pullRequestNumber: pull.data?.number, pullRequestUrl: pull.data?.html_url, draft: true, message: "JDAP created a feature branch, committed the approved ABAP source, and opened a draft pull request. Nothing was merged." };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return {
      ok: false,
      status: timeout ? 504 : 502,
      state: timeout ? (branchCreated ? "branch-created-operation-timeout" : "timeout") : (branchCreated ? "branch-created-operation-partial" : "pull-request-create-failed"),
      branchCreated,
      branchName: branchCreated ? target.branchName : undefined,
      branchUrl: branchCreated ? branchUrl : undefined,
      commitUrl: commitUrl || undefined,
      message: timeout
        ? `GitHub write timed out${branchCreated ? ` after creating ${target.branchName}` : ""}. Check the repository before retrying.`
        : `${error.message}${branchCreated ? ` The feature branch ${target.branchName} was created${commitUrl ? ` and the source commit is at ${commitUrl}` : ""}, but JDAP could not finish the pull request. Check GitHub before retrying.` : " No branch or commit was confirmed."}`
    };
  } finally { clearTimeout(timer); }
}

async function getJson(path, token, signal, fetchImpl) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "JDAP-read-only-git-integration"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`${GITHUB_API}${path}`, { headers, signal, redirect: "error" });
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw new Error("GitHub returned an oversized response; the repository preview was stopped.");
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { throw new Error(`GitHub returned an unexpected response (HTTP ${response.status}, ${contentType || "unknown content type"}).`); }
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error(response.status === 401 ? "GitHub rejected the token. Check the token and repository access." : "GitHub denied the request or its API rate limit was reached. Check repository access and try later.");
    if (response.status === 404) throw new Error("GitHub could not find this repository for the supplied access. Check the URL and token permissions.");
    throw new Error(`GitHub repository read failed with HTTP ${response.status}.`);
  }
  return data;
}

export async function readGitHubRepository({ repositoryUrl, token = "" }, fetchImpl = fetch) {
  let repository;
  try { repository = parseRepositoryUrl(repositoryUrl); }
  catch (error) { return { ok: false, status: 400, state: "invalid-repository-url", message: error.message }; }
  const accessToken = String(token || "").trim();
  if (accessToken.length > 500) return { ok: false, status: 400, state: "invalid-token", message: "The GitHub token is too long." };
  const basePath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const get = (path) => getJson(path, accessToken, controller.signal, fetchImpl);
    const [repo, branches, commits] = await Promise.all([
      get(basePath),
      get(`${basePath}/branches?per_page=20`),
      get(`${basePath}/commits?per_page=10`)
    ]);
    return {
      ok: true,
      state: "repository-readable",
      provider: "github",
      repository: {
        name: repo.full_name,
        description: repo.description || "",
        private: Boolean(repo.private),
        defaultBranch: repo.default_branch || "",
        htmlUrl: repo.html_url || `https://github.com/${repository.owner}/${repository.name}`,
        updatedAt: repo.updated_at || ""
      },
      branches: Array.isArray(branches) ? branches.map(branch => ({ name: branch.name, sha: branch.commit?.sha || "" })) : [],
      commits: Array.isArray(commits) ? commits.map(item => ({
        sha: item.sha || "",
        shortSha: String(item.sha || "").slice(0, 7),
        message: String(item.commit?.message || "").split(/\r?\n/, 1)[0].slice(0, 240),
        author: item.commit?.author?.name || item.author?.login || "",
        date: item.commit?.author?.date || ""
      })) : [],
      note: "Read-only preview. JDAP did not clone the repository, create a branch, or change Git content. The optional token was used for this request only and was not stored."
    };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return { ok: false, status: timeout ? 504 : 502, state: timeout ? "timeout" : "repository-read-failed", message: timeout ? "GitHub repository preview timed out." : error.message };
  } finally { clearTimeout(timer); }
}
