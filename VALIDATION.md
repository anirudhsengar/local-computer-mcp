# Validation guide

This document describes checks to run on an installation. It is not a claim that a particular account, machine, dependency version, or client has passed them. Keep raw output, local paths, host identifiers, job records, screenshots, and account details in ignored local storage, not in committed documentation.

## Service-generation regressions

From the repository root:

```bash
node --test test/service.test.mjs
bash -n scripts/ops.sh scripts/run-server.sh
node --check scripts/render-service.mjs
```

The service tests use temporary directories and mock systemctl/tunnel commands; they do not restart the real service or enable root access. They cover installation-directory generation, Node selection, spaces and systemd specifiers, invalid configuration rejection, private unit permissions, temporary-file cleanup, and preservation of an existing unit on rendering failure. When `systemd-analyze` is installed, the suite also checks generated units with the actual parser; otherwise that check is explicitly skipped.

## Host integration

After completing setup on a supported development host:

```bash
npm test
bash scripts/ops.sh tunnel-doctor
bash scripts/ops.sh status
```

The integration suite exercises the MCP protocol, file operations, localhost fetching, command jobs, terminals, concurrency, Git/patch operations, browser screenshots, restart behavior, and resource byte/hash comparisons. It uses separate job state, but it is not an isolated-container test. Read the suite before running it on a computer containing important data. Record exact commands and actual exit codes locally; do not label unexecuted checks as passing.

## Client acceptance

Run the prompts in `CHATGPT_HANDOFF.md` in the intended client. Check tool discovery, the configured access mode, attachment import, and file retrieval in both directions. For output delivery, independently compare the client-retrieved bytes and SHA-256 with the source. Metadata alone does not demonstrate that a file crossed the transport successfully.

For media workflows, render a short non-sensitive sample, probe dimensions/duration/codecs, fully decode it with FFmpeg, inspect representative frames, and check audio. Verify the revised output after edits rather than relying on job submission or a previous render.

## Before sharing source or diagnostics

Review the entire tracked tree and all reachable Git history with a secret scanner and manual inspection. Include branch/tag refs, commit author/committer email addresses, documentation, configuration, and any GitHub issues, releases, or workflow artifacts. A scanner returning no findings is not proof that every private detail has been removed.

Deleting a file or adding it to `.gitignore` does not remove older commits. History rewriting is a separate operation, and stale clones can reintroduce old history. GitHub may retain cached commit views after a rewrite. Follow [GitHub's removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) before declaring historical data purged. Keep credentials local and use the account's GitHub noreply address for commits when email privacy is required.
