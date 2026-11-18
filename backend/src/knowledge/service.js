import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const KNOWLEDGE_ROOT = fileURLToPath(new URL("../../knowledge-base/", import.meta.url));
const DOMAINS = ["abap", "cds", "rap", "odata", "sap-standards"];

function parseDocument(domain, filename, raw) {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) return null;
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const split = line.indexOf(":");
    if (split < 1) continue;
    metadata[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(metadata.id || "") || !metadata.title || !metadata.summary) return null;
  return {
    id: metadata.id,
    title: metadata.title,
    summary: metadata.summary,
    domain,
    tags: (metadata.tags || "").split(",").map(tag => tag.trim()).filter(Boolean),
    sourceName: metadata.sourceName || "JDAP working guidance",
    sourceUrl: metadata.sourceUrl || "",
    updated: metadata.updated || "",
    workflowApproved: metadata.workflowApproved === "true",
    filename,
    content: match[2].trim()
  };
}

async function readAllDocuments() {
  const documents = [];
  for (const domain of DOMAINS) {
    const directory = path.join(KNOWLEDGE_ROOT, domain);
    let files;
    try { files = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const file of files) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith(".md") || file.name.startsWith("_")) continue;
      const raw = await readFile(path.join(directory, file.name), "utf8");
      const document = parseDocument(domain, file.name, raw);
      if (document) documents.push(document);
    }
  }
  return documents.sort((a, b) => a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title));
}

export async function listKnowledge({ query = "", domain = "" } = {}) {
  const docs = await readAllDocuments();
  const normalizedQuery = String(query).trim().toLowerCase();
  const normalizedDomain = String(domain).trim().toLowerCase();
  return docs.filter(doc => {
    if (normalizedDomain && normalizedDomain !== "all" && doc.domain !== normalizedDomain) return false;
    if (!normalizedQuery) return true;
    return [doc.title, doc.summary, doc.domain, ...doc.tags, doc.content].join(" ").toLowerCase().includes(normalizedQuery);
  }).map(({ content, ...summary }) => summary);
}

export async function getKnowledge(id) {
  const docs = await readAllDocuments();
  return docs.find(doc => doc.id === id) || null;
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "your", "are", "was", "were", "have", "has", "how", "what", "when", "where", "why", "can", "could", "should", "would", "will", "about", "using", "use", "create", "build", "make", "need", "want", "please", "help", "application", "program", "report"]);

function terms(value) {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9_]{3,}/g) || [])].filter(term => !STOP_WORDS.has(term));
}

export async function retrieveWorkflowKnowledge(prompt, { maxItems = 3, maxChars = 4800 } = {}) {
  const promptTerms = terms(prompt);
  if (!promptTerms.length) return [];
  const documents = (await readAllDocuments()).filter(document => document.workflowApproved);
  const ranked = documents.map(document => {
    const titleTerms = terms(document.title);
    const tagTerms = terms(document.tags.join(" "));
    const bodyTerms = terms(document.content);
    const score = promptTerms.reduce((total, term) => total
      + (titleTerms.includes(term) ? 5 : 0)
      + (tagTerms.includes(term) ? 3 : 0)
      + (bodyTerms.includes(term) ? 1 : 0), 0);
    return { document, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
    .slice(0, Math.max(1, Math.min(Number(maxItems) || 3, 5)));

  let remaining = Math.max(500, Math.min(Number(maxChars) || 4800, 8000));
  const results = [];
  for (const { document, score } of ranked) {
    if (remaining <= 0) break;
    const excerpt = document.content.slice(0, remaining).trim();
    if (!excerpt) continue;
    results.push({ id: document.id, title: document.title, domain: document.domain, filename: document.filename, sourceName: document.sourceName, sourceUrl: document.sourceUrl, excerpt, score });
    remaining -= excerpt.length;
  }
  return results;
}

export const knowledgeDomains = [...DOMAINS];
