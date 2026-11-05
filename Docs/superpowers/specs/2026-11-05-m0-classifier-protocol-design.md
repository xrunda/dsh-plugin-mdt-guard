# M0 Classifier Protocol Validation Design

## Goal

Complete issue #2 with a repeatable, dependency-free local conformance harness
for the classifier gateway requirements in PRD FR-3, while clearly separating
the behavior of a test reference client from the not-yet-implemented
production classifier client and from hospital connectivity.

## Scope

- Exercise an OpenAI-compatible `POST /v1/chat/completions` request and a
  strict classifier JSON response against a local mock service. The expected
  classifier object is `{ "decision": "allow|deny|unknown", "category":
  "A|B|C|D|E|F|G|H|I", "reason": "<string>", "confidence": 0..1 }`, carried
  as JSON content in the OpenAI chat completion response.
- Verify `temperature: 0` and `max_tokens: 200` request constraints, a 1500 ms
end-to-end
  request timeout measured from dispatch until the complete response is
  received or the request aborts, and that timeout does not retry.
- Verify default TLS certificate validation rejects an untrusted certificate,
  a hostname mismatch is rejected, and explicitly configured custom CA trust
  succeeds for the certificate's matching hostname.
- Verify an HTTPS request can be sent through a configured local HTTP CONNECT
  proxy, that the proxy receives the expected CONNECT authority, and that
  origin-certificate and hostname validation remain enabled through the
  tunnel.
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
  `temperature: 0`, `max_tokens: 200`, no retry after timeout, TLS trust and
  hostname rejection/acceptance, and HTTPS through a local CONNECT proxy with
  asserted CONNECT authority.
- An issue #2 report at `Docs/M0-classifier-protocol-validation.md` with
  runtime versions, exact command/results, configuration requirements for the
  hospital, and explicit limits of the test-only reference client.

## Verification

- Run the full harness command and confirm all tests pass, including the
  self-signed certificate and proxy cases.
- Start the end-to-end timer immediately before dispatch and stop only after
  the response is fully received or the request aborts. Use a response delayed
  to 2500 ms, assert abort elapsed time is between 1200 ms and 2500 ms
  (tolerance around the 1500 ms policy), and confirm the mock observes exactly
  one request after the delayed handler has completed.
- Ensure untrusted CA and hostname mismatch both fail rather than falling back
  to insecure TLS; verify the matching hostname succeeds only with the
  explicitly configured test CA.
- Ensure the proxy observes the exact `CONNECT localhost:<port>` request and
  the tunneled TLS handshake still rejects untrusted or hostname-mismatched
  certificates.
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
- Certificate fixtures must distinguish the trusted test CA from a leaf
  certificate containing a `localhost` Subject Alternative Name; the
  hostname-mismatch case must use a leaf that lacks `localhost` in its SAN and
  a different request host name.
- Hospital-specific model, CA, proxy, and authentication values are unknown.
  Keep them as a checklist for the hospital and do not invent defaults beyond
  PRD FR-3.
