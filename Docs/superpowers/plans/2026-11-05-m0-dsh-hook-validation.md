# M0 DSH Hook Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve issue #1's DSH host-integration assumptions using versioned, authoritative evidence and publish a reproducible report that separates verified behavior from hospital-only checks.

**Architecture:** This is a documentation-led validation task, not production plugin implementation. Trace the relevant extension behavior from authoritative DSH artifacts for rc.3 and rc.5, record evidence and limitations in one report, and add a local contract test only if source inspection establishes a stable contract worth testing without a live host.

**Tech Stack:** GitHub/source and release inspection; Markdown; existing Git and GitHub CLI. No new runtime or test dependencies.

---

## File map

- Create `Docs/M0-plugin-hook-validation.md`: evidence, findings, reproducible procedures, compatibility conclusion, and hospital follow-up checklist.
- Read `Docs/PRD.md`: product requirements, compatibility statements, and issue acceptance criteria.
- Read `Docs/superpowers/specs/2026-11-05-m0-dsh-hook-validation-design.md`: evidence precedence, scope, and reporting constraints.
- Read GitHub issue `#1`: the agreed scope and acceptance criteria for this deliverable.
- Do not add a test harness unless the public source establishes a stable host contract that can be meaningfully exercised without DSH. If so, keep it isolated and document exactly what it does not prove.

### Task 1: Identify authoritative DSH sources

**Files:**
- Read: `Docs/PRD.md`
- Read: `Docs/superpowers/specs/2026-11-05-m0-dsh-hook-validation-design.md`

- [ ] **Step 1: Extract the exact product/version claims and extension-point names**

  Read the issue body with `gh issue view 1 --repo xrunda/dsh-plugin-mdt-guard`. Record the stated DSH versions (`0.2.1-rc.3` and `0.2.1-rc.5`), `agent/pre-step`, `{ kind: 'reject' }`, profile installation, blocked-turn rendering, server/client deployment claims, and acceptance criteria from the PRD and issue #1.

- [ ] **Step 2: Locate the official upstream source and versioned artifacts**

  Start from any DSH project links in the repository or official product documentation. Verify the owner and repository identity before treating a source as authoritative. Locate the rc.3 and rc.5 tags/release artifacts, or record that one or both are not publicly accessible.

- [ ] **Step 3: Record source provenance before drawing conclusions**

  For each source, record its URL, version/tag, and source type. When evidence conflicts, use the specific version's tagged source/release artifact first, then versioned documentation, then current unversioned documentation; preserve the conflict in the report.

### Task 2: Trace plugin loading and pre-step rejection behavior

**Files:**
- Create: `Docs/M0-plugin-hook-validation.md`

- [ ] **Step 1: Trace plugin registration and profile loading for each accessible version**

  Follow the registration and load path from the versioned source or official documentation. Record the required manifest/patch entry, profile location, server-side versus desktop loading boundary, and any version-specific differences. Do not infer missing details from PRD prose.

- [ ] **Step 2: Trace the `agent/pre-step` waterfall and reject result**

  Follow the hook registration, invocation, and result handling in the tagged implementation. Record whether `{ kind: 'reject' }` is a supported result for each version, what lifecycle work occurs before/after the hook, and source links to the relevant definitions and call sites.

- [ ] **Step 3: Determine what the available evidence proves about upstream model calls**

  Follow the request path after pre-step rejection. State whether source inspection proves the model call is skipped. If runtime instrumentation is required to establish the behavior, define the needed host test and mark it as unverified until run; do not describe source-level inference as hospital runtime evidence.

- [ ] **Step 4: Add a local contract test only if it tests a verified contract**

  If the source reveals a stable, useful contract that can be tested without DSH, add the smallest isolated test using the repository's available tooling. Otherwise explicitly record why no local mock test was added; a mock must not assert guessed hook signatures or simulate hospital behavior.

### Task 3: Trace refusal rendering and deployment boundaries

**Files:**
- Modify: `Docs/M0-plugin-hook-validation.md`

- [ ] **Step 1: Inspect supported host-side refusal/message APIs**

  Determine from versioned source/docs whether a plugin can add the fixed assistant-side refusal without fabricating a model response. Link the API and lifecycle evidence, or mark the capability unknown.

- [ ] **Step 2: Inspect blocked-turn/client rendering behavior**

  Determine whether a rejected turn exposes a supported blocked state to web and desktop clients and whether a plugin/client integration can render the fixed text. Record separately for each client surface; do not claim client coverage from server hook existence alone.

- [ ] **Step 3: Build a verification matrix**

  Include rc.3 and rc.5 rows and columns for plugin load, profile install path, pre-step reject semantics, upstream-call evidence, refusal visibility, web/server enforcement, desktop behavior, evidence source, and unresolved validation. Use `verified`, `not supported`, or `requires hospital test` consistently.

### Task 4: Complete the report and hospital test procedure

**Files:**
- Modify: `Docs/M0-plugin-hook-validation.md`

- [ ] **Step 1: Write the compatibility conclusion**

  State the strongest evidence-backed conclusion for each version. Recommend a refusal-rendering approach only if supported by evidence; otherwise leave the choice unresolved. Never state that hospital compatibility is confirmed based solely on public artifacts.

- [ ] **Step 2: Add reproducible steps and expected observations**

  For every performed local/source check, record the exact artifact/version, navigation or command sequence, observed result, and the expected evidence. Distinguish source inspection, local contract tests, and live-host tests.

- [ ] **Step 3: Add the hospital follow-up checklist**

  Include the target DSH build/profile, actual web and desktop deployment, visible fixed refusal, a rejected request with upstream model-call counter/log evidence, and client-switch bypass checks. Mark each item as pending hospital access unless it was actually run.

- [ ] **Step 4: Summarize blockers and decisions needed**

  List inaccessible private artifacts, missing runtime access, and any open design choices as explicit blockers with the evidence needed to resolve each one. Do not include real endpoint values or credentials.

### Task 5: Verify the report against the issue and commit

**Files:**
- Read: `Docs/PRD.md`
- Read: `Docs/superpowers/specs/2026-11-05-m0-dsh-hook-validation-design.md`
- Verify: `Docs/M0-plugin-hook-validation.md`

- [ ] **Step 1: Check issue acceptance criteria one by one**

  Confirm the report covers version/environment, reproducible evidence, no-model-call proof or a clearly specified host test, refusal presentation, rc.3 compatibility, and unresolved blockers.

- [ ] **Step 2: Check every positive claim and privacy boundary**

  Re-run every source inspection or local procedure recorded in the report. Verify each positive claim links to authoritative version-specific evidence or a reproducible observation and that rerun results agree with the report. Confirm no secrets, patient data, private endpoint values, or unsupported hospital claims appear.

- [ ] **Step 3: Run available documentation/test checks**

  Run the repository's existing checks if any are introduced during the work. If the task remains documentation-only and no documentation checks exist, record that no runtime test applies rather than adding unrelated tooling.

- [ ] **Step 4: Commit the issue deliverable**

  ```bash
  git add Docs/M0-plugin-hook-validation.md
  git commit -m "docs: validate DSH pre-step integration"
  ```
