/**
 * Rule compilation and evaluation for the MDT guard bundle.
 *
 * `compileRules` turns the effective `hardDeny` / `fastAllow` source arrays
 * into frozen, pre-compiled rule sets. `evaluateRules` normalizes one message
 * and applies the hard-deny rules first, then the fast-allow rules, returning
 * a stable identity for audit.
 *
 * Both exports are pure: they log nothing, perform no I/O, call no classifier,
 * and never return or retain the input text. Invalid sources raise the same
 * sanitized `ConfigError` as configuration loading so direct callers cannot
 * bypass validation.
 */

import { ConfigError } from './config.js';
import {
  FAST_ALLOW_RULES,
  HARD_DENY_RULES,
  RULE_REGEX_FLAGS,
} from './rule-defaults.js';

const CONFIG_FIELD_INVALID = 'CONFIG_FIELD_INVALID';
const CONFIG_RULE_INVALID = 'CONFIG_RULE_INVALID';

const ERROR_TEMPLATES = {
  [CONFIG_FIELD_INVALID]: 'Invalid configuration field',
  [CONFIG_RULE_INVALID]: 'Invalid regular expression in configuration field',
};

// A full-string whitespace predicate equivalent to /^[\s\u0085]*$/.
// String#trim() and \s alone miss U+0085 (NEL).
const WHITESPACE_ONLY = /^[\s\u0085]*$/;
// Zero-width characters stripped before matching. Kept as explicit escapes so
// no invisible literal ever lives in this source file.
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
// Collapse all whitespace, including U+0085 (NEL), to a single space. NEL is
// matched explicitly because `\s` does not include it; this must stay in
// parity with config.js's /^[\s\u0085]*$/ source predicate.
const WHITESPACE_RUN = /[\s\u0085]+/g;

function fail(code, field) {
  const template = ERROR_TEMPLATES[code] ?? ERROR_TEMPLATES[CONFIG_FIELD_INVALID];
  throw new ConfigError(code, field, `${template} "${field}"`);
}

function isRuleConfig(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map a built-in source to its catalog identity. Sources are unique within a
 * catalog, so a custom source identical to a built-in one keeps the built-in
 * ID and category instead of becoming an indexed custom rule.
 */
function builtInMetadata(rules) {
  const metadata = new Map();
  for (const rule of rules) {
    metadata.set(rule.source, { id: rule.id, category: rule.category });
  }
  return metadata;
}

const HARD_DENY_METADATA = builtInMetadata(HARD_DENY_RULES);
const FAST_ALLOW_METADATA = builtInMetadata(FAST_ALLOW_RULES);

function compileBuiltIns(rules) {
  return Object.freeze(
    rules.map((rule) =>
      Object.freeze({
        id: rule.id,
        category: rule.category,
        regexp: new RegExp(rule.source, RULE_REGEX_FLAGS),
      }),
    ),
  );
}

/**
 * Compile one rule field.
 *
 * An omitted field or an explicit empty array uses the built-in catalog. A
 * non-empty array replaces the whole built-in list for that field: entries
 * equal to a built-in source keep the catalog identity, all others become
 * `<field>[<index>]` with a `null` category.
 */
function compileField(value, field, builtInRules, builtInSourceMetadata) {
  if (value === undefined) {
    return compileBuiltIns(builtInRules);
  }
  if (!Array.isArray(value)) {
    fail(CONFIG_FIELD_INVALID, field);
  }
  if (value.length === 0) {
    return compileBuiltIns(builtInRules);
  }

  // The array iterator does not skip holes, so sparse arrays are rejected at
  // the array field instead of silently normalizing to `undefined` items.
  for (const item of value) {
    if (typeof item !== 'string') {
      fail(CONFIG_FIELD_INVALID, field);
    }
  }

  const compiled = [];
  for (const [index, source] of value.entries()) {
    const indexedField = `${field}[${index}]`;
    if (WHITESPACE_ONLY.test(source)) {
      fail(CONFIG_FIELD_INVALID, indexedField);
    }

    let regexp;
    try {
      regexp = new RegExp(source, RULE_REGEX_FLAGS);
    } catch {
      fail(CONFIG_RULE_INVALID, indexedField);
    }

    const builtIn = builtInSourceMetadata.get(source);
    compiled.push(
      Object.freeze({
        id: builtIn === undefined ? indexedField : builtIn.id,
        category: builtIn === undefined ? null : builtIn.category,
        regexp,
      }),
    );
  }

  return Object.freeze(compiled);
}

/**
 * Compile the effective rule configuration once.
 *
 * Only `hardDeny` and `fastAllow` are read; unrelated configuration fields are
 * neither validated nor touched. The input only has to be a non-null,
 * non-array object: validating it as a plain object and checking unrelated
 * fields is `validateConfig`'s job. Every call returns fresh frozen arrays and
 * rule objects, so callers may hold compiled sets without sharing state.
 *
 * @param {object} config
 * @returns {{ hardDeny: ReadonlyArray<object>, fastAllow: ReadonlyArray<object> }}
 * @throws {TypeError} when `config` is not a non-null, non-array object
 * @throws {ConfigError} for invalid field shapes, empty sources or bad regexes
 */
export function compileRules(config) {
  if (!isRuleConfig(config)) {
    throw new TypeError('compileRules expects a configuration object');
  }

  return Object.freeze({
    hardDeny: compileField(
      config.hardDeny,
      'hardDeny',
      HARD_DENY_RULES,
      HARD_DENY_METADATA,
    ),
    fastAllow: compileField(
      config.fastAllow,
      'fastAllow',
      FAST_ALLOW_RULES,
      FAST_ALLOW_METADATA,
    ),
  });
}

/**
 * Normalize a message for rule matching without retaining the original text.
 *
 * NFKC folds full-width forms, zero-width characters are removed, whitespace
 * (including U+0085 NEL) runs collapse to one space, and the result is
 * trimmed.
 */
function normalizeText(text) {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

function firstMatch(rules, text) {
  for (const rule of rules) {
    if (rule.regexp.test(text)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Evaluate one message against a compiled rule set.
 *
 * Hard-deny rules run in order before any fast-allow rule, so a message that
 * matches both is denied. No match returns `unknown` for the classifier path.
 *
 * @param {{ hardDeny: ReadonlyArray<object>, fastAllow: ReadonlyArray<object> }} ruleSet
 * @param {string} text
 * @returns {{ decision: 'deny'|'allow'|'unknown', category: string|null, ruleId: string|null }}
 * @throws {TypeError} when `text` is not a string
 */
export function evaluateRules(ruleSet, text) {
  if (typeof text !== 'string') {
    throw new TypeError('evaluateRules expects a string message');
  }

  const normalized = normalizeText(text);

  const denied = firstMatch(ruleSet.hardDeny, normalized);
  if (denied !== undefined) {
    return Object.freeze({
      decision: 'deny',
      category: denied.category,
      ruleId: denied.id,
    });
  }

  const allowed = firstMatch(ruleSet.fastAllow, normalized);
  if (allowed !== undefined) {
    return Object.freeze({
      decision: 'allow',
      category: allowed.category,
      ruleId: allowed.id,
    });
  }

  return Object.freeze({ decision: 'unknown', category: null, ruleId: null });
}
