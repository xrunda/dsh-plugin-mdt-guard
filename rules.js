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

import { validateRuleSourceArray } from './config.js';
import {
  FAST_ALLOW_RULES,
  HARD_DENY_RULES,
  RULE_REGEX_FLAGS,
  replaceFormatCharactersWithSpace,
  stripFormatCharacters,
} from './rule-defaults.js';

// Collapse all whitespace, including U+0085 (NEL), to a single space. NEL is
// matched explicitly because `\s` does not include it. The whitespace-only
// source predicate itself is shared with config.js via
// `validateRuleSourceArray` so both entry points reject the same sources.
const WHITESPACE_RUN = /[\s\u0085]+/g;

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
 * equal to a built-in source from the same field keep the catalog identity,
 * all others become `<field>[<index>]` with a `null` category. Validation is
 * delegated to `validateRuleSourceArray`, so `compileRules` and
 * `validateConfig` keep identical error codes, indexed fields and ordering.
 */
function compileField(value, field, builtInRules, builtInSourceMetadata) {
  if (value === undefined) {
    return compileBuiltIns(builtInRules);
  }
  if (Array.isArray(value) && value.length === 0) {
    return compileBuiltIns(builtInRules);
  }

  validateRuleSourceArray(value, field);

  const compiled = [];
  for (const [index, source] of value.entries()) {
    const indexedField = `${field}[${index}]`;
    const builtIn = builtInSourceMetadata.get(source);
    compiled.push(
      Object.freeze({
        id: builtIn === undefined ? indexedField : builtIn.id,
        category: builtIn === undefined ? null : builtIn.category,
        regexp: new RegExp(source, RULE_REGEX_FLAGS),
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
 * @throws {ConfigError} for invalid field shapes, empty sources, sources that
 *   message normalization erases or folds, or bad regexes
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
 * Produce the variants a message is matched against without retaining the
 * original text.
 *
 * NFKC folds full-width forms and the text is trimmed. Three variants cover
 * the three meanings whitespace has under normalization:
 *
 * 1. Cf format characters and variation selectors are erased, whitespace
 *    collapses to one space: English token spacing such as `show system
 *    prompt` is preserved.
 * 2. The same stripped text has all whitespace removed: separators inserted
 *    inside a CJK token (`打 印 config.json`) are caught.
 * 3. Each Cf format character and variation selector is replaced by one
 *    space instead of being erased: a format character cannot silently
 *    replace an inter-token space (`give<Cf>me` still matches `give me`).
 *
 * Variants are deduplicated while preserving this order, so plain text
 * produces one or two entries instead of three.
 */
function normalizeVariants(text) {
  const folded = text.normalize('NFKC');
  const stripped = stripFormatCharacters(folded).trim();
  const collapsed = stripped.replace(WHITESPACE_RUN, ' ').trim();
  const compact = stripped.replace(WHITESPACE_RUN, '');
  const spaced = replaceFormatCharactersWithSpace(folded)
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  return [...new Set([collapsed, compact, spaced])];
}

function firstMatch(rules, variants) {
  for (const rule of rules) {
    for (const variant of variants) {
      if (rule.regexp.test(variant)) {
        return rule;
      }
    }
  }
  return undefined;
}

/**
 * Evaluate one message against a compiled rule set.
 *
 * Hard-deny rules run in order, across every normalization variant, before any
 * fast-allow rule, so a message that matches both is denied. No match returns
 * `unknown` for the classifier path.
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

  const variants = normalizeVariants(text);

  const denied = firstMatch(ruleSet.hardDeny, variants);
  if (denied !== undefined) {
    return Object.freeze({
      decision: 'deny',
      category: denied.category,
      ruleId: denied.id,
    });
  }

  const allowed = firstMatch(ruleSet.fastAllow, variants);
  if (allowed !== undefined) {
    return Object.freeze({
      decision: 'allow',
      category: allowed.category,
      ruleId: allowed.id,
    });
  }

  return Object.freeze({ decision: 'unknown', category: null, ruleId: null });
}
