# M1 Built-in Rules and Rule Evaluation Design

## Goal

Implement issue #5: built-in G/H hard-deny rules and C/D fast-allow rules
that run before any classifier call, can be overridden through the server
configuration, and return a stable rule identity for audit.

This issue adds a pure rule module. It does not wire the rules into
`agent/pre-step` (issue #6) or the session state machine (issue #10).

## Decisions

- Replace the empty `hardDeny` / `fastAllow` placeholders introduced by the
  configuration issue with concrete built-in rule sources.
- Keep the configuration shape from PRD FR-9: both fields are arrays of
  regular-expression source strings. Rule identifiers and categories live in
  code, not in the user configuration.
- Override semantics:
  - Field omitted or supplied as `[]` -> built-in rules are used.
  - Non-empty array -> replaces the entire built-in list for that field.
  This is a deliberate fail-safe exception to the configuration issue's
  "arrays replace defaults" rule: an empty array must not silently disable
  G/H hard-deny. Disabling the whole gate remains available through
  `enabled: false`.
- Compile every source with the `i` flag only. Rules receive text normalized
  with NFKC, `U+200B`–`U+200D` and `U+FEFF` removed, and whitespace (including
  `U+0085` NEL) collapsed; the original message is never modified or retained.
- Evaluate all hard-deny rules before any fast-allow rule. A message matching
  both is denied.
- A fast-allow match is a terminal "do not call the classifier" result. For
  category D (continuations and greetings), the result is an allow
  candidate; issue #10 owns whether the current session state turns it into
  a denial.
- Invalid regular expressions are explicit errors. `validateConfig` rejects
  them at load time with `CONFIG_RULE_INVALID`, and `compileRules` rejects
  them again so direct callers cannot bypass validation. Messages contain
  only the field path, never the pattern.
- Audit identity: built-in rules return stable IDs such as
  `hard-deny.prompt-injection`; custom rules return `hardDeny[<index>]` /
  `fastAllow[<index>]` with a `null` category. The module never logs or
  returns message text.
- No classifier, audit sink, DSH hook, or `index.js` wiring is added here.

## Configuration and Effective Rules

`validateConfig` returns fresh arrays. `hardDeny` and `fastAllow` normalize
as follows:

| Input | Normalized value |
|---|---|
| omitted | built-in sources |
| `[]` | built-in sources |
| non-empty string array | the supplied sources, returned verbatim (no trimming or rewriting) |
| non-array, sparse array, or non-string item | `CONFIG_FIELD_INVALID` at the array field (`hardDeny` / `fastAllow`) |
| array containing an empty or whitespace-only source (including U+0085 NEL) | `CONFIG_FIELD_INVALID` at the indexed field (`hardDeny[<index>]` / `fastAllow[<index>]`) |
| array containing a source with invalid regex syntax | `CONFIG_RULE_INVALID` at the indexed field (`hardDeny[<index>]` / `fastAllow[<index>]`) |

The built-in catalogs are defined once in `rule-defaults.js` and shared by
the validator and the rule compiler, so defaults and metadata cannot drift.

## Built-in Rule Catalog

### Hard deny (G: system/ops, H: injection)

| ID | Cat | Coverage |
|---|---|---|
| `hard-deny.prompt-injection` | H | ignore/forget/bypass prior instructions, rules or limits; English equivalents |
| `hard-deny.role-switch` | H | role-play or "act as" another assistant/doctor/model |
| `hard-deny.system-prompt-exfiltration` | H | reveal system prompt, internal rules or hidden instructions |
| `hard-deny.any-question-permission` | H | "you may now answer anything" style permission claims |
| `hard-deny.jailbreak` | H | jailbreak / DAN mode / unrestricted mode |
| `hard-deny.sensitive-path` | G | `~/.dsh`, `~/.ssh`, `/root`, `/etc/dsh`, `/etc/passwd`, DSH install directory |
| `hard-deny.read-sensitive` | G | read/print config, logs, tokens, secrets, certificates, environment variables |
| `hard-deny.read-sensitive-reverse` | G | same nouns followed by location/read verbs |
| `hard-deny.command-exec` | G | execute shell/PowerShell/terminal commands or scripts |
| `hard-deny.software-install` | G | install/uninstall/upgrade software, runtimes or packages |
| `hard-deny.config-modify` | G | modify config files, environment, registry, HIS address or logs |
| `hard-deny.service-ops` | G | restart/stop/debug services, processes or the DSH host |

The full sources are reproduced in the implementation plan and live in
`rule-defaults.js`. Rule text stays intentionally conservative: it targets
system nouns and imperative verbs, and must not match benign MDT phrases such
as "修改治疗方案", "查看检查结果", "这个药怎么用" or "作为医生".

### Fast allow (C: software help, D: continuations/greetings)

| ID | Cat | Coverage |
|---|---|---|
| `fast-allow.greeting` | D | whole-message greetings (`你好`, `hello`, ...) |
| `fast-allow.continuation` | D | whole-message acknowledgements/continuations (`好的`, `继续`, `谢谢`, `展开说说`, ...) |
| `fast-allow.software-help` | C | questions about this plugin, software, PPT, version, login or download |

Greetings and continuations are whole-message anchored so that
"好的，我头疼吃什么药" is not fast-allowed. Software-help rules require a
software noun near a question word so that "这个药怎么用" and
"在哪里下载检查报告" are not fast-allowed.

## Module API

```js
export function compileRules(config) -> {
  hardDeny: ReadonlyArray<{ id, category, regexp }>,
  fastAllow: ReadonlyArray<{ id, category, regexp }>,
}

export function evaluateRules(ruleSet, text) -> {
  decision: 'deny' | 'allow' | 'unknown',
  category: 'C' | 'D' | 'G' | 'H' | null,
  ruleId: string | null,
}
```

- `compileRules` compiles once per configuration; `evaluateRules` is
  synchronous and allocation-light per message.
- `decision: 'unknown'` means "no rule matched; the gate may call the
  classifier". `deny` and `allow` are terminal.
- Both exports are pure, log nothing, write nothing, and never include the
  input text in errors or results.

## Error Handling

- Empty or whitespace-only sources are rejected before compilation as
  `CONFIG_FIELD_INVALID` with the indexed field (`hardDeny[<index>]` or
  `fastAllow[<index>]`), using a full-string predicate equivalent to
  `/^[\s\u0085]*$/` because `String#trim()` and `\s` alone miss U+0085 (NEL).
  Failure modes differ by field: an empty `fastAllow` source matches every
  message and fails open; an empty `hardDeny` source matches every message and
  denies everything, which is a fail-closed availability loss rather than
  fail-open. Whitespace-only sources are meaningless and can match most
  normalized multi-word messages. Zero-width accuracy: sources made only of
  characters stripped by evaluation normalization (U+200B–U+200D, U+FEFF) are
  inert; U+FEFF is rejected here as whitespace; other zero-width characters
  (for example U+200E, U+2060, U+00AD) are neither stripped nor rejected.
- Only non-empty sources are compiled. A source with invalid syntax raises
  `CONFIG_RULE_INVALID` with the indexed field.
- Message templates identify the field only. No pattern, input text, parser
  detail or `cause` is attached.
- Custom sources are server-admin-controlled and evaluated synchronously
  without a timeout. Catastrophic backtracking (ReDoS) is therefore possible;
  bounding custom-regex execution is out of scope.
- `compileRules` accepts a raw config object and applies the same empty ->
  built-in rule; it throws `TypeError` only for a non-object config.

## Testing

- Table-driven hard-deny cases for every built-in rule, using PRD examples
  plus case, full-width, zero-width and whitespace (including U+0085 NEL)
  variants.
- Table-driven fast-allow cases for greetings, continuations and software
  help, including whole-message anchoring.
- Negative cases proving benign MDT/medical phrasing falls through to
  `unknown` (classifier path).
- Priority test: a message matching both a hard-deny and fast-allow rule is
  denied; the hard-deny rule ID is returned.
- Override tests: omitted and empty arrays use built-ins; a non-empty custom
  array replaces them and returns `hardDeny[0]` / `fastAllow[0]`.
- Invalid-regex tests for both configuration loading and direct
  `compileRules`, asserting code, field, sanitized message and no `cause`.
- Mutation tests proving normalized arrays and compiled rule sets are fresh
  and do not share built-in objects.

## Out of Scope

- `agent/pre-step` integration and fixed refusal UX (issue #6).
- Session state transitions and continuation inheritance (issue #10).
- Classifier client, audit persistence, tool restrictions and hot reload.
- ReDoS protection for administrator-supplied regular expressions.
- Claiming the rules are a complete security boundary. The PRD explicitly
  treats this as policy convergence, not a security boundary.
