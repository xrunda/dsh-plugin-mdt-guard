# M1 Plugin Skeleton and DSH Registration Design

## Goal

Implement issue #3 by establishing an independently installable `dsh-mdt-guard`
Host-only bundle, a no-op plugin lifecycle entry, and stable contracts for
future gate, configuration, and audit modules. The skeleton must not change
default DSH behavior when disabled and must not implement behavior assigned to
later issues.

## Evidence and Constraints

- The PRD identifies `dsh-mdt-guard` as a standalone repository/plugin, separate
  from `dsh-plugin-hzhospital`, with server-side enforcement.
- Issue #1's report verifies that DSH `0.2.1-rc.5` supports Host bundle
  registration through a package manifest's `dsh.bundle.patch`, a
  `cordis.patch.yml` plugin row, and an `apply(ctx, config)` Host entry.
- The same report does not verify a hospital profile or deployment.
- The local DSH CLI is `0.2.1-rc.5`. The user approved using an isolated,
  temporary test profile; no existing profile should be changed.
- The repository currently has no application source, package manifest,
  dependency policy, or build/test framework beyond the issue #2 Node test
  harness.

## Approaches Considered

1. **Native ESM Host-only bundle (selected).** Use DSH's documented package
   shape and Node built-ins only. This avoids a build chain and keeps the
   package close to the verified Host API.
2. **TypeScript plus a bundler.** This provides compile-time checking but adds
   dependencies, generated output, and packaging decisions before there is
   runtime logic to justify them.
3. **Implement functional gate/config/audit modules now.** This could provide
   immediate behavior, but overlaps later issues and would make this skeleton
   difficult to validate independently.

## Proposed Design

### Package and registration

Create a private ESM package named `@local/dsh-mdt-guard`, with a package-root
`index.js` export and `dsh.bundle.patch` pointing to `cordis.patch.yml`. The
patch inserts one uniquely identified Host plugin row, `dsh-mdt-guard`, with
empty configuration. Declare only the files needed at runtime and for DSH
display metadata. Do not add install scripts, runtime dependencies, build
tools, or profile-specific files to the repository.

Provide meaningful English and Chinese title/description metadata and an
original, small SVG icon so the installed bundle is identifiable in Plugin
Manager. These resources describe the plugin as an MDT topic guard, not as a
working enforcement implementation.

### Lifecycle and module boundary

The exported `apply(ctx, config)` is an intentionally empty lifecycle hook.
It registers no DSH event, service, tool, or UI resource; reads no files or
configuration; calls no model; and emits no audit records. This makes the
enabled skeleton observable as an installed plugin without introducing
behavior, while disabling the row leaves DSH behavior untouched.

Add a declaration-only `types/contracts.d.ts` contract file for the next
modules, using PRD terms:

- `GateInput` contains `sessionId: string`, `currentMessage: string`, a
  readonly list of `{ role: user | assistant, content: string }` recent
  messages, and session state `in_scope | out_of_scope | unknown`.
- `GateDecision` contains `decision: allow | deny | unknown`, category
  `A | B | C | D | E | F | G | H | I`, a reason string, and numeric
  confidence in the closed interval [0, 1].
- `ConfigProvider<TConfig>` exposes `load(): Promise<TConfig>`.
- `AuditWriter<TEvent>` exposes `write(event: TEvent): Promise<void>`.

The provider and writer are generic at this boundary so issue #4 can define
the validated configuration shape and issue #7 can define the complete
privacy-aware audit event without duplicating those schemas here. These are
contracts only. This issue does not add runtime stubs that silently allow,
deny, or fabricate audit success. Later issues implement the contracts and
test them with injected mocks.

### Verification

- Add dependency-free Node tests under `tests/plugin-skeleton.test.mjs` for
  package metadata and exports, patch identity/config, contract declaration
  presence, and importability of the no-op lifecycle entry.
- Run `node --test tests/model-gateway/*.test.mjs
  tests/plugin-skeleton.test.mjs` and `git diff --check`.
- Use only a newly created isolated profile based on the local DSH `web`
  template for the live smoke test. Install/activate the local bundle only
  through an official DSH-supported workflow, verify the plugin is loaded,
  and verify it is disabled afterward. Do not edit or overwrite the user's
  existing profile. If the installed CLI does not expose a supported bundle
  activation path, stop at the documented limitation rather than editing
  profile state by hand.
- Record the DSH version, commands, observed activation result, and any
  limitation in a short issue report. A local profile smoke test is not
  hospital deployment evidence.

## Out of Scope

- Gate rules, classifier calls, configuration loading/validation, and audit
  persistence.
- Changes to DSH itself or `dsh-plugin-hzhospital`.
- UI refusal rendering or claims that this empty skeleton enforces the PRD.
- Hospital profile, credentials, network, or deployment validation.

## Risks

- Package installation and plugin-row activation are distinct DSH operations.
  The local smoke test must use a supported path for both; package presence
  alone is not evidence that the entry loaded.
- The local `0.2.1-rc.5` check does not establish compatibility with every
  hospital build or profile.
- Declaration-only contracts do not prove future implementations conform;
  later issues must add focused runtime tests using mocks.
