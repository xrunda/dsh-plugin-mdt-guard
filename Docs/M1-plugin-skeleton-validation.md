# M1 Plugin Skeleton Validation

## Result

- DSH CLI `0.2.1-rc.5` initialized and ran an isolated `smoke` profile.
- `dsh plugin add` installed the local bundle and selected it in the profile. `dsh --profile smoke --dump-config` showed exactly one `dsh-mdt-guard` row for `@local/dsh-mdt-guard`.
- Passing `cordis.patch.yml` again with `--patch` produced a duplicate row. The smoke procedure therefore relies on the patch declared by the installed package and does not use a CLI patch overlay.
- The DSH web process started without startup errors. An unauthenticated request to its local root returned HTTP 401, as expected by the web authentication gate. No authenticated Plugin Manager/runtime inspection was completed, so live execution of `apply()` remains **unverified**; the composed row and successful server startup are not activation proof.
- After removing the bundle with DSH's plugin command, the profile config no longer contained the row. The baseline web process responded with HTTP 401 at its unauthenticated local root.
- The isolated DSH home was removed after testing. No existing profile was accessed or changed.

## Reproduction

Run these commands with a fresh, disposable `DSH_HOME` and the repository's absolute path:

```bash
dsh --version
dsh --profile smoke --from-default-profile web --dump-config
dsh plugin --profile smoke add <absolute-path-to-repository>
dsh --profile smoke --dump-config
dsh --profile smoke --no-open --host 127.0.0.1 --port 0
```

Stop the first web process before removing the bundle and starting the baseline:

```bash
dsh plugin --profile smoke remove @local/dsh-mdt-guard
dsh --profile smoke --dump-config
dsh --profile smoke --no-open --host 127.0.0.1 --port 0
```

The installed bundle is selected by DSH and its manifest patch is composed automatically. Do not add `--patch <absolute-path-to-repository>/cordis.patch.yml` to these commands; doing so applies the same row twice.

## Static Checks

All 14 Node tests passed. The syntax check and whitespace check also exited successfully.

```bash
node --test tests/model-gateway/*.test.mjs tests/plugin-skeleton.test.mjs
node --check index.js
git diff --check
```

## Scope

This issue adds only an inert Host bundle and declaration-only contracts. It does not implement gate rules, configuration loading, classification, audit behavior, or user-facing refusal. Hospital profiles and deployments require separate environment-specific verification; this local rc.5 smoke test is not deployment evidence. See [PRD](./PRD.md) and [the approved design](./superpowers/specs/2026-11-05-m1-plugin-skeleton-design.md).
