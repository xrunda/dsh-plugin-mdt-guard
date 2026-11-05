# M0 Classifier Protocol Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a repeatable, dependency-free test harness that exercises the classifier gateway protocol, timeout, TLS trust, and proxy requirements against local mocks for issue #2.

**Architecture:** Keep all test code in `tests/model-gateway/`. A short-lived local HTTP/HTTPS mock and CONNECT proxy provide controlled responses; a clearly test-only reference client exercises the contract using Node built-ins. An issue report records results and explicitly distinguishes this harness from the future production client and hospital network.

**Tech Stack:** Node.js 24 built-in `node:test`, `http`, `https`, `tls`, `net`, `child_process`, `fs`, `os`, `path`; OpenSSL for ephemeral test certificates. No package dependencies.

---

## File map

- Create `tests/model-gateway/test-certificates.mjs`: use OpenSSL to create a temporary test CA and a localhost-only server certificate; return paths and cleanup.
- Create `tests/model-gateway/mock-gateway.mjs`: start controllable local HTTP/HTTPS chat-completion endpoints and an HTTP CONNECT proxy; expose counters and deterministic close methods.
- Create `tests/model-gateway/reference-client.mjs`: implement a small test-only OpenAI-compatible POST client with end-to-end timeout, optional CA, and optional CONNECT proxy; do not export it as a production package API.
- Create `tests/model-gateway/conformance.test.mjs`: exercise request/response contract, strict classifier JSON, timeout/no retry, TLS verification, and proxy tunneling.
- Create `Docs/M0-classifier-protocol-validation.md`: record runtime, exact test command/results, requirements matrix, outstanding hospital parameters, and test-only boundary.
- Read `Docs/PRD.md` FR-3 and `Docs/superpowers/specs/2026-11-05-m0-classifier-protocol-design.md` as the contract source.

### Task 1: Add isolated ephemeral certificate fixtures

**Files:**
- Create: `tests/model-gateway/test-certificates.mjs`
- Test: `tests/model-gateway/conformance.test.mjs`

- [ ] **Step 1: Write a failing fixture test**

  Add a `node:test` case that calls `createTestCertificates()`, verifies the returned CA certificate, CA key, leaf certificate, and leaf key files exist under a unique temporary directory, and registers cleanup in `t.after`.

- [ ] **Step 2: Run the focused test**

  Run: `node --test tests/model-gateway/conformance.test.mjs`
  Expected: FAIL because `test-certificates.mjs` does not yet exist.

- [ ] **Step 3: Implement ephemeral CA and localhost leaf generation**

  Use `fs.mkdtemp` under `os.tmpdir()`. Invoke `openssl` through `execFileSync` with a bounded timeout to create a CA and a server certificate whose SAN is `DNS:localhost` only. Return PEM paths and an async cleanup that removes only this generated temp directory. If OpenSSL is missing or fails, throw an actionable test setup error; do not skip TLS tests.

- [ ] **Step 4: Run the focused test**

  Run: `node --test tests/model-gateway/conformance.test.mjs`
  Expected: the certificate fixture case passes and cleanup removes its directory.

### Task 2: Create mock gateway and CONNECT proxy

**Files:**
- Create: `tests/model-gateway/mock-gateway.mjs`
- Test: `tests/model-gateway/conformance.test.mjs`

- [ ] **Step 1: Write failing mock endpoint tests**

  Add tests that start the mock gateway and send a simple request to `/v1/chat/completions`. Assert it records method/path/body and can return a successful OpenAI response envelope. Add a delayed response mode and a malformed-content mode.

- [ ] **Step 2: Run the focused tests**

  Run: `node --test tests/model-gateway/conformance.test.mjs`
  Expected: FAIL because `mock-gateway.mjs` does not yet exist.

- [ ] **Step 3: Implement controlled HTTP/HTTPS mock servers**

  Export `createMockGateway({ keyPath, certPath, mode })`. Bind only to `127.0.0.1` on ephemeral ports. Record request method, URL, headers, parsed JSON body, and count. Support `success`, `malformed`, and `delay` modes while always responding only to `/v1/chat/completions`; return an OpenAI envelope with classifier JSON at `choices[0].message.content`.

- [ ] **Step 4: Implement a local CONNECT proxy fixture**

  Export `createConnectProxy()`. On `connect`, record the exact requested authority, accept only `localhost:<port>`, connect to the mock origin at loopback, and pipe both sockets. Expose a close method that closes the listening server and active tunnels.
  Track client and upstream sockets; cleanup destroys both socket sets first, then awaits the proxy server's `close` event so no test remains pending.

- [ ] **Step 5: Run the focused tests**

  Register `t.after` cleanup in each test for its gateway, active proxy
  tunnels, and certificate directory before running:
  `node --test tests/model-gateway/conformance.test.mjs`
  Expected: mock endpoint tests pass; no external host is contacted.

### Task 3: Implement the test-only reference transport and conformance cases

**Files:**
- Create: `tests/model-gateway/reference-client.mjs`
- Modify: `tests/model-gateway/conformance.test.mjs`

- [ ] **Step 1: Write failing request-contract assertions**

  Call `postChatCompletion` with a local mock URL and a synthetic prompt. Assert method `POST`, exact path `/v1/chat/completions`, parsed body fields `temperature: 0`, `max_tokens: 200`, and model/messages. Parse `choices[0].message.content` and assert `decision`, `category`, `reason`, and numeric `confidence` are valid.

- [ ] **Step 2: Run the focused test**

  Run: `node --test tests/model-gateway/conformance.test.mjs`
  Expected: FAIL because `reference-client.mjs` does not yet exist.

- [ ] **Step 3: Implement the direct reference client**

  Implement `postChatCompletion({ url, body, timeoutMs = 1500, ca, proxyUrl })` using `http`/`https`/`tls`. Start one total-request timer immediately before dispatch; include proxy connection, CONNECT, TLS handshake, upload, and full response body receipt. For `proxyUrl`, issue an HTTP `CONNECT <hostname>:<port>`, require a 200 response, then wrap that socket in `tls.connect({ socket, servername: hostname, ca })` and hand the verified TLS socket to the HTTPS request through a small custom `https.Agent`. Do not disable hostname or certificate validation. Abort/destroy the active request, tunnel, and TLS socket at timeout. Do not retry. Pass `ca` only when explicitly supplied. Parse the OpenAI envelope and strict classifier JSON; reject malformed JSON, missing fields, invalid enum values, or confidence outside 0..1.

- [ ] **Step 4: Add timeout and no-retry tests**

  Configure the mock to respond after 3500 ms. Assert the client rejects with its explicit timeout error (not a generic socket/network error) between 1200 ms and 2500 ms, before the delayed response is released. Then wait for the mock handler to complete and assert exactly one request was received.

- [ ] **Step 5: Add TLS trust and hostname tests**

  Against the HTTPS mock, assert the request fails with the default trust store, succeeds for `https://localhost:<port>` only when the generated CA is configured, and fails for `https://127.0.0.1:<port>` with that same CA because the leaf certificate has no IP SAN. Do not set `rejectUnauthorized: false`.

- [ ] **Step 6: Add HTTPS CONNECT proxy tests**

  Call `postChatCompletion` with `proxyUrl` set to the local proxy. Assert it sends `CONNECT localhost:<origin-port>`, requires a 200 CONNECT response, and then sends HTTPS through that tunnel. With the test CA configured, assert the mock receives exactly one request. Also test that the proxied TLS path rejects an untrusted CA and hostname mismatch.

- [ ] **Step 7: Run the complete harness**

  Confirm every top-level test registers `t.after` cleanup for all resources
  it starts, then run: `node --test tests/model-gateway/*.test.mjs`
  Expected: all protocol, timeout, TLS, and proxy tests pass; every test's cleanup closes servers/tunnels and removes generated certificate directories.

### Task 4: Write the issue report and final verification

**Files:**
- Create: `Docs/M0-classifier-protocol-validation.md`
- Read: `Docs/PRD.md`
- Read: `Docs/superpowers/specs/2026-11-05-m0-classifier-protocol-design.md`

- [ ] **Step 1: Record reproducible test results**

  Include `node --version`, `openssl version`, exact harness command, test count/result, and the behaviors each test proves. State that the test-only reference client—not a production classifier client—was exercised.

- [ ] **Step 2: Add the hospital configuration checklist**

  List model base URL, model name, auth requirement and secure server-side key source, approved CA file, proxy type/address/auth requirement, TLS hostname, and network reachability as values the hospital must supply. Leave values blank/pending; never invent endpoints or credentials.

- [ ] **Step 3: Verify privacy and scope boundaries**

  Confirm no real credentials/endpoints, generated certificates, patient data, or production-client claims are in the report or diff. State that issue #8 must later run its actual client against this mock and that hospital connectivity remains unverified.

- [ ] **Step 4: Re-run all checks and commit**

  Run:

  ```bash
  node --test tests/model-gateway/*.test.mjs
  git diff --check
  ```

  Then commit:

  ```bash
  git add tests/model-gateway Docs/M0-classifier-protocol-validation.md
  git commit -m "test: validate classifier gateway protocol for #2"
  ```
