# M1 Plugin Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable, no-op DSH Host bundle with stable module contracts and verify it against the local DSH `0.2.1-rc.5` in an isolated profile.

**Architecture:** Use a private native ESM package with no runtime dependencies or build step. Its `cordis.patch.yml` registers an intentionally empty `apply(ctx, config)` Host plugin; declaration-only TypeScript contracts define boundaries for later gate/config/audit issues. Local Node tests validate package and lifecycle invariants, followed by a smoke test in a disposable profile.

**Tech Stack:** Node.js ESM, built-in `node:test`, DSH `0.2.1-rc.5` CLI, YAML patch format documented by DSH. No npm dependencies.

---

## File Map

- Create `package.json`: private package identity, ESM root export, bundle patch pointer, exported display resources, and packed file allowlist.
- Create `cordis.patch.yml`: one unique `dsh-mdt-guard` Host row with empty config.
- Create `index.js`: inert `apply(ctx, config)` lifecycle export.
- Create `types/contracts.d.ts`: shared module input/result and generic provider/writer interfaces.
- Create `locale/en.json` and `locale/zh.json`: meaningful bundle title and description.
- Create `icon.svg`: original local icon for the Plugin Manager entry.
- Create `tests/plugin-skeleton.test.mjs`: dependency-free checks for package metadata, patch identity, module contracts, and inert entry behavior.
- Create `Docs/M1-plugin-skeleton-validation.md`: exact static and local DSH smoke-test steps/results, including verification limits.

## Task 1: Write failing package and patch tests

**Files:**
- Create: `tests/plugin-skeleton.test.mjs`
- Read: `package.json`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg`

- [ ] **Step 1: Add a Node test for the package manifest**

  Use `node:assert/strict`, `node:fs/promises`, and `node:test`. Read the manifest relative to `import.meta.url` and assert:

  - `name` is `@local/dsh-mdt-guard`, `private` is `true`, and `type` is `module`.
  - The root export resolves to `./index.js`.
  - `dsh.bundle.patch` is `./cordis.patch.yml`.
  - There are no runtime dependencies or install scripts.
  - The file allowlist includes the patch, entry, contracts, locale JSON, and icon.

- [ ] **Step 2: Add tests for bundle registration and display resources**

  Read the patch and locale files as text/JSON. Assert the single row uses id `dsh-mdt-guard`, package name `@local/dsh-mdt-guard`, and empty `config`; assert both locales contain non-empty `meta.title` and `meta.description`; assert the package icon path is local and the SVG source has an `svg` root with no external URL references.

- [ ] **Step 3: Run the focused test and observe the expected failure**

  Run: `node --test tests/plugin-skeleton.test.mjs`

  Expected: FAIL because the package and registration files do not exist yet. Do not add a YAML or XML dependency just for these checks.

- [ ] **Step 4: Commit the failing tests**

  ```bash
  git add tests/plugin-skeleton.test.mjs
  git commit -m "test: define DSH plugin bundle skeleton contract"
  ```

## Task 2: Add the minimal installable bundle

**Files:**
- Create: `package.json`
- Create: `cordis.patch.yml`
- Create: `locale/en.json`
- Create: `locale/zh.json`
- Create: `icon.svg`
- Test: `tests/plugin-skeleton.test.mjs`

- [ ] **Step 1: Add the ESM bundle manifest**

  Use package name `@local/dsh-mdt-guard`, version `0.1.0`, `private: true`, and `type: module`. Export `.` as `./index.js`, export `./locale/*.json` and `./icon`, and set `dsh.bundle.patch` to `./cordis.patch.yml`. Include only the runtime/metadata files in `files`; do not add dependencies, scripts, build configuration, or profile paths.

- [ ] **Step 2: Add the one-row Host bundle patch**

  Add a single insert row:

  ```yaml
  - insert:
      - id: dsh-mdt-guard
        name: '@local/dsh-mdt-guard'
        config: {}
  ```

- [ ] **Step 3: Add localized display metadata and an original SVG**

  Provide concise English and Simplified Chinese descriptions that say this package is the MDT topic-guard plugin without implying that gate behavior is already implemented. Use an original, simple SVG that has no external references.

- [ ] **Step 4: Run the focused tests**

  Run: `node --test tests/plugin-skeleton.test.mjs`

  Expected: the package metadata, patch, locale, and icon checks pass. The test should fail with actionable assertions if a required bundle field or resource is missing.

- [ ] **Step 5: Commit the bundle metadata**

  ```bash
  git add package.json cordis.patch.yml locale/en.json locale/zh.json icon.svg
  git commit -m "feat: add DSH host bundle registration"
  ```

## Task 3: Add the no-op entry and module contracts

**Files:**
- Create: `index.js`
- Create: `types/contracts.d.ts`
- Modify: `package.json`
- Modify: `tests/plugin-skeleton.test.mjs`

- [ ] **Step 1: Add failing lifecycle and contract assertions**

  Assert that `index.js` exports a callable `apply`. Invoke it with a context proxy that throws on every property access and an empty config; assert it returns `undefined` and registers no event, service, tool, or UI resource. Read the declaration file and assert it includes the exact `GateInput`, `GateDecision`, `ConfigProvider<TConfig>`, and `AuditWriter<TEvent>` contracts from the approved spec.

- [ ] **Step 2: Run the focused test and observe the expected failure**

  Run: `node --test tests/plugin-skeleton.test.mjs`

  Expected: FAIL because the entry and declaration file are not present.

- [ ] **Step 3: Implement the inert Host lifecycle entry**

  Export `function apply(ctx, config) {}` from `index.js`. Do not inspect context/config or register resources. Keep the entry free of runtime imports so DSH can load the package without initializing future modules.

- [ ] **Step 4: Declare structural contracts without runtime stubs**

  In `types/contracts.d.ts`, define:

  ```ts
  export type SessionState = 'in_scope' | 'out_of_scope' | 'unknown';
  export type Category = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
  export type Decision = 'allow' | 'deny' | 'unknown';

  export interface GateInput {
    sessionId: string;
    currentMessage: string;
    recentMessages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
    sessionState: SessionState;
  }

  export interface GateDecision {
    decision: Decision;
    category: Category;
    reason: string;
    confidence: number;
  }

  export interface ConfigProvider<TConfig> {
    load(): Promise<TConfig>;
  }

  export interface AuditWriter<TEvent> {
    write(event: TEvent): Promise<void>;
  }
  ```

  Add no implementation that can imply a successful gate result or audit write.

- [ ] **Step 5: Include the entry and contracts in the package file allowlist**

  Ensure package consumers receive `index.js` and `types/contracts.d.ts`.

- [ ] **Step 6: Run focused tests and syntax checks**

  Run:

  ```bash
  node --test tests/plugin-skeleton.test.mjs
  node --check index.js
  ```

  Expected: all focused tests pass and Node reports no syntax errors.

- [ ] **Step 7: Commit the entry and contracts**

  ```bash
  git add index.js types/contracts.d.ts package.json tests/plugin-skeleton.test.mjs
  git commit -m "feat: define inert host entry and guard contracts"
  ```

## Task 4: Verify the bundle with local DSH

**Files:**
- Read: `package.json`, `cordis.patch.yml`, `index.js`
- Test: isolated DSH profile only

- [ ] **Step 1: Confirm the runtime and choose a fresh profile name**

  Run `dsh --version`, `dsh --help`, and `dsh plugin --help`; record the version and confirm the exact options/subcommands needed below are advertised by this installation. Use a unique profile name such as `mdt-guard-issue3-smoke-0bdcce4`. Check only that exact profile path under the documented DSH profiles directory before creation; if the path exists or the directory is uncertain, choose another unique name or stop. Never use or overwrite a profile the user already uses.

- [ ] **Step 2: Initialize a disposable profile from the shipped web template**

  Use the supported DSH CLI form `dsh <profile-name> --from-default-profile web --dump-config` to create the isolated profile and exit after composing its configuration. Do not manually edit files under the DSH home/profile directory.

- [ ] **Step 3: Install the local bundle using DSH's plugin command**

  Run:

  ```bash
  dsh plugin --profile <profile-name> add <absolute-path-to-repository>
  ```

  This uses the installed DSH CLI to manage the profile's package dependency. Do not run pnpm directly in the profile directory.

- [ ] **Step 4: Verify DSH composes the registration patch**

  Apply the workspace patch as an official CLI overlay and inspect the composed configuration:

  ```bash
  dsh <profile-name> --patch <absolute-path-to-repository>/cordis.patch.yml --dump-config
  ```

  Confirm the composed Host row resolves to id `dsh-mdt-guard` and package `@local/dsh-mdt-guard`. If this command reports that the patch cannot resolve the package, stop and record the exact error; do not hand-edit profile files or invent a second installation mechanism.

- [ ] **Step 5: Boot the isolated profile with the patch and record activation evidence**

  Start the profile through `dsh <profile-name> --patch <absolute-path-to-repository>/cordis.patch.yml`. Verify a positive, live activation state through a DSH-supported plugin inventory/inspection surface (for example, Plugin Manager or runtime inspection); a composed patch row or absence of startup errors alone is not proof that the entry loaded. If this local installation exposes no supported activation-status surface, record activation as unverified and do not claim the issue's live-load acceptance passed. Stop only the specific test process after recording its result. Do not access or modify any existing profile.

- [ ] **Step 6: Verify the no-plugin baseline**

  Start the same disposable profile without a patch overlay. Confirm the default DSH startup remains available and record that the bundle row is absent in this baseline. Do not claim that absence of the row is a hospital deployment test.

- [ ] **Step 7: Record verification scope**

  Record DSH version, profile name, commands, whether package installation/composition/boot succeeded, and any observable activation limitation. Clearly state that this is a local rc.5 smoke test, not a hospital profile/deployment verification.

## Task 5: Add the validation report and run final checks

**Files:**
- Create: `Docs/M1-plugin-skeleton-validation.md`
- Read: `Docs/PRD.md`
- Read: `Docs/superpowers/specs/2026-11-05-m1-plugin-skeleton-design.md`

- [ ] **Step 1: Write the exact reproduction and result**

  Document the Node test command, DSH version, isolated-profile commands actually run, observed outcome, and the difference between package install, patch composition, and plugin activation.

- [ ] **Step 2: State scope and follow-up boundaries**

  State that this issue adds only a no-op Host bundle and module contracts. Configuration, rules, classifier, audit behavior, user-facing refusal, and hospital deployment remain for their own issues or environment verification.

- [ ] **Step 3: Run all tests and patch hygiene**

  Run:

  ```bash
  node --test tests/model-gateway/*.test.mjs tests/plugin-skeleton.test.mjs
  node --check index.js
  git diff --check
  ```

  Expected: all tests pass, syntax check exits 0, and `git diff --check` reports no whitespace errors.

- [ ] **Step 4: Check the package for accidental secrets or local-profile files**

  Confirm no real endpoints, credentials, patient data, generated profile files, or DSH home paths are in the package or diff. Confirm the package `files` allowlist includes all runtime and display resources but excludes tests and reports.

- [ ] **Step 5: Commit the validation report**

  ```bash
  git add Docs/M1-plugin-skeleton-validation.md
  git commit -m "docs: record plugin skeleton validation for #3"
  ```
