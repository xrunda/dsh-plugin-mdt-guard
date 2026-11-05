# M1 Server Configuration Design

## Goal

Implement issue #4 by loading and validating the server-side MDT guard
configuration for later gate, classifier, rules, audit, and tool-policy
modules. Configuration handling must not introduce enforcement behavior in
this issue.

## Decisions

- Read `~/.dsh/mdt/guard.json` by default, resolving `~` from Node's
  `os.homedir()`. Allow an explicit file path for isolated tests.
- Keep file I/O separate from pure configuration normalization and
  validation. Export `loadConfig({ filePath? })` and
  `validateConfig(input)`.
- Merge provided nested objects over defaults; arrays replace their defaults
  as a whole. Reject unknown keys to catch misspellings rather than silently
  ignoring them.
- A missing file starts from PRD defaults, including `enabled: true`.
  `classifier.baseUrl` and `classifier.model` are required when enabled.
  Therefore a missing file without those values raises a sanitized
  `ConfigError`; the caller must leave the guard inactive and DSH behavior
  unchanged. With `enabled: false`, those two connection fields are not
  required. Any supplied values are still validated.
- Use only Node built-ins; do not add a runtime dependency or integrate
  configuration loading into the currently inert `index.js`. Runtime
  consumption and reporting belong to the gate-integration issue.
- Provide a credential-free example JSON file under `Docs/`; do not include
  documentation or tests in the npm package file allowlist.

## Configuration Shape and Defaults

| Field | Default | Validation |
|---|---|---|
| `enabled` | `true` | boolean |
| `classifier.baseUrl` | absent | absolute `http:` or `https:` URL; required when enabled |
| `classifier.model` | absent | non-empty string; required when enabled |
| `classifier.apiKey` | absent | optional non-empty string |
| `classifier.caCertFile` | absent | optional non-empty string |
| `classifier.timeoutMs` | `1500` | integer from 100 through 60000 |
| `classifier.maxTokens` | `200` | integer from 1 through 4096 |
| `contextTurns` | `3` | integer from 0 through 20 |
| `failOpen` | `true` | boolean |
| `hardDeny` | `[]` | array of strings; concrete rules are issue #5 |
| `fastAllow` | `[]` | array of strings; concrete rules are issue #5 |
| `refusalText` | PRD fixed Chinese refusal text | non-empty string |
| `audit.enabled` | `true` | boolean |
| `audit.storeText` | `false` | boolean |
| `audit.retentionDays` | `30` | integer from 1 through 3650 |
| `tools.allow` | `[]` | array of strings; actual names are issue #12 |
| `tools.deny` | `[]` | array of strings; actual names are issue #12 |

The default refusal text is: `本助手仅提供 MDT 多学科会诊相关支持，暂无法处理该请求。如需其他帮助，请联系信息科。`

`hardDeny`, `fastAllow`, and tool arrays are structural placeholders in this
issue, not active policy. Later issues supply concrete rules and tool names.

## Error Handling and Secret Safety

- Missing files use defaults before validation. Invalid JSON, inaccessible
  files, unknown properties, invalid types, out-of-range values, and missing
  required fields raise `ConfigError` with a stable code and field-oriented
  message.
- Error messages may identify the config path and field name, but never embed
  the value, raw JSON, parser detail, or `apiKey`. The loader does not log
  config contents or create directories/files.
- Configuration errors are surfaced to the caller; this module does not add a
  logger. The future runtime integration must report them safely and keep the
  guard inactive so DSH retains its default behavior.
- `enabled: false` is a valid, normalized configuration and does not require
  classifier endpoint/model settings.
- `failOpen` controls classifier failures, not malformed configuration:
  invalid configuration is always an explicit error and must not be silently
  converted to a successful enabled/default result.

## Testing

Use built-in `node:test` and temporary files/directories only. Tests cover:

- Default field values and missing-file behavior, including the required
  classifier-field error for the enabled default.
- Valid complete config and partial nested config merge behavior.
- Explicitly disabled config without endpoint/model.
- Missing required fields, unknown fields, wrong types, malformed JSON, and
  all numeric lower/upper boundaries and out-of-range cases.
- Safe errors: include useful field context while excluding sentinel API key
  values and raw configuration text.
- No modification of a real home directory and no config-file creation.

The documented example contains no real endpoint or credential. Add the
configuration module to package exports and the runtime file allowlist; keep
the sample and tests out of the shipped package.

## Out of Scope

- Registering runtime hooks or changing `index.js` behavior.
- Implementing classifier requests, gate rules, audit persistence, session
  state, or tool restrictions.
- Hot reload, configuration-file generation, and hospital deployment
  validation.
