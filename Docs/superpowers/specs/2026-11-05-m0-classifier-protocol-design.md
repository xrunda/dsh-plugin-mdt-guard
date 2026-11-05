# M0 Classifier Protocol Validation Design

## Goal

Complete issue #2 with a repeatable, dependency-free local conformance harness
for the classifier gateway requirements in PRD FR-3, while clearly separating
the behavior of a test reference client from the not-yet-implemented
production classifier client and from hospital connectivity.

## Scope

- Exercise an OpenAI-compatible `POST /v1/chat/completions` request and a
  strict classifier JSON response against a local mock service.
- Verify temperature/output-token request constraints, a 1500 ms timeout,
  and that timeout does not retry.
- Verify default TLS certificate validation rejects an untrusted certificate,
  while explicitly configured custom CA trust succeeds.
- Verify an HTTPS request can be sent through a configured local HTTP CONNECT
  proxy without disabling certificate validation.
- Document that hospital model URL, model name, authentication, CA and proxy
  settings remain environment-specific and unverified.

This issue does not implement production classifier logic, store real
credentials, connect to a hospital model, or claim that a reference transport
proves the future plugin client works.

## Approach

Use the available Node.js runtime and built-in modules only (`node:test`,
`http`, `https`, `tls`, and `net`). Keep all harness code under
`tests/model-gateway/`, with distinct responsibilities for mock endpoints,
the test-only reference client, and conformance tests.

Generate a short-lived self-signed test CA/server certificate at runtime using
the local `openssl` executable in a unique temporary directory; remove the
directory in test cleanup. Never commit generated keys/certificates or contact
external services.

The reference client must be explicitly labeled test-only. Its CA and proxy
options demonstrate how the conformance harness exercises these network
conditions; they are not a production API contract for issue #8.

## Deliverables

- A dependency-free test command: `node --test tests/model-gateway/*.test.mjs`.
- A local mock service returning controlled success, malformed, delayed, and
  TLS responses and counting received requests.
- Tests covering request method/path/body, valid classifier response shape,
  no retry after timeout, TLS trust rejection/acceptance, and HTTPS through a
  local CONNECT proxy.
- An issue #2 report at `Docs/M0-classifier-protocol-validation.md` with
  runtime versions, exact command/results, configuration requirements for the
  hospital, and explicit limits of the test-only reference client.

## Verification

- Run the full harness command and confirm all tests pass, including the
  self-signed certificate and proxy cases.
- Ensure timeout bounds are asserted with tolerance and the mock observes
  exactly one request.
- Ensure invalid/untrusted TLS fails rather than falling back to insecure
  mode.
- Confirm each test closes servers/sockets and deletes its unique temporary
  certificate directory, even on failure.
- Search the diff for embedded credentials, production endpoints, and
  generated certificate material.

## Risks and handling

- A passing reference-client test does not prove issue #8 production code
  conforms. State this prominently and require the production client to run
  against the same mock when it is implemented.
- `openssl` availability is needed for ephemeral test certificates. Fail with
  an actionable error if it is missing; do not silently skip TLS checks.
- Hospital-specific model, CA, proxy, and authentication values are unknown.
  Keep them as a checklist for the hospital and do not invent defaults beyond
  PRD FR-3.
