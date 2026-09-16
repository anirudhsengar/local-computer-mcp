# ChatGPT connection checks

These are reusable checks for an operator's own installation, not a record of a particular account or computer. Configure and validate the tunnel using the README before connecting a client. Replace placeholders with paths returned by tools in your own session; never share runtime credentials.

## Discovery and access mode

> Use Local Computer. Call `computer_status` and report the server version, tool readiness, and access mode. Confirm that `unattended_root` matches the operator's intended configuration; do not assume it is enabled. Do not modify files or change privileges.

Expected tools: `computer_status`, `workspace`, `read_file`, `write_file`, `import_file`, `fetch_url`, `exec_command`, `write_stdin`, `process`, `repository`, `apply_patch`, `media`, `browser`, and `artifact`.

Status output contains host identity, paths, and resource information. Review and redact it before posting it publicly. Authentication does not create a sandbox: commands run with the configured Unix user's permissions, and optional root access is unrestricted.

## Arbitrary-file delivery

Choose a small, non-sensitive file created for testing, and use its actual absolute path:

> Use Local Computer. Call `artifact` with path `<absolute path to a non-sensitive test file>`. Confirm that the result includes a `resource_link`. Retrieve it through the client's resource support, not through a second local tool call. Compare the retrieved byte count and SHA-256 against the source metadata. Report a delivery as successful only after inspecting the retrieved bytes. If this client cannot retrieve the resource, report the unsupported step rather than treating the local path as a downloadable file.

Client support and transport behavior must be tested in the actual client being used. Do not reuse another installation's expected hashes or artifact paths.

## Attachment import

Attach a small, non-sensitive test file, then use a fresh destination:

> Import the attached file with `import_file` into `<absolute path to a new test destination>`. Call `read_file` with action `stat`, that exact returned path, and `hash: true`. Compare its byte count and SHA-256 with the source. Do not overwrite existing work.

## Parallel sessions and shutdown

Give each chat a unique workspace/directory and browser session name. Sessions share the same account, machine, files, and external logins. Avoid simultaneous edits to the same checkout or path.

Use `process` or `write_stdin` for job completion rather than inferring success from submission. Accepted jobs may outlive a chat, but the assistant does not automatically continue after disconnect. `bash scripts/ops.sh stop` stops the local service and its descendants; uninstalling the service is not credential revocation or secure data erasure.
