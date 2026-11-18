# GitHub integration

The read-only view accepts HTTPS `github.com` repository URLs and reads repository metadata, up to 20 branches, and up to 10 recent commits through the GitHub REST API.

- Public repositories can be read without a token.
- Private repositories use a user-supplied fine-grained GitHub token with read access. JDAP keeps it in request memory only and does not persist or log it.
- The URL is validated against the GitHub host; arbitrary hosts are rejected.
- The adapter does not clone repositories or create branches, commits, tags, or pull requests.

Endpoint: `POST /api/git/repository/read` with `{ repositoryUrl, token }`. GitHub is the first supported provider; provider expansion remains future roadmap work.

## Approved ABAP draft pull requests

`GET /api/git/approved-drafts` lists current approved JDAP artifacts that contain a declared ABAP report. `POST /api/git/pull-requests/preview` checks the selected base branch and destination `.abap` file, then returns a unified diff without writing to GitHub.

`POST /api/git/pull-requests/create` rechecks approval, quality blockers, Clean Core review evidence, the base commit, and destination file SHA before creating the requested `jdap/` branch, committing the approved source, and opening a draft pull request. It requires the exact confirmation `CREATE DRAFT PULL REQUEST` and a user-supplied fine-grained token with repository contents write and pull-requests write access. Tokens are not persisted. The base branch is not changed and the pull request is never merged by JDAP.

GitHub does not provide a transaction across branch, contents, and pull-request APIs. If a later step fails after branch creation, the response and audit record identify the partial result; JDAP does not automatically delete the branch or commit.
