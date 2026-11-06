import { buildClassifierMessages } from './classifier-context.js';
import { evaluateRules } from './rules.js';
import { createSessionStateStore } from './session-state.js';

const DECISIONS = new Set(['allow', 'deny', 'unknown']);
const CATEGORIES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
const DEFAULT_CONTEXT_TURNS = 3;

const GATE_ERROR_CODES = Object.freeze({
  CLASSIFIER_UNAVAILABLE: 'CLASSIFIER_UNAVAILABLE',
  CLASSIFIER_ERROR: 'CLASSIFIER_ERROR',
  GATE_ERROR: 'GATE_ERROR',
});

function degradedResult(errorCode, reason) {
  return {
    decision: 'unknown',
    category: 'I',
    reason,
    confidence: 0,
    degraded: true,
    errorCode,
  };
}

function normalizeClassifierResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return degradedResult(GATE_ERROR_CODES.CLASSIFIER_ERROR, 'classifier_unavailable');
  }
  if (!DECISIONS.has(result.decision) || !CATEGORIES.has(result.category)) {
    return degradedResult(GATE_ERROR_CODES.CLASSIFIER_ERROR, 'classifier_unavailable');
  }
  if (result.degraded === true && result.decision !== 'unknown') {
    return degradedResult(GATE_ERROR_CODES.CLASSIFIER_ERROR, 'classifier_unavailable');
  }
  if (typeof result.reason !== 'string'
    || typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence)
    || result.confidence < 0
    || result.confidence > 1) {
    return degradedResult(
      result.errorCode ?? GATE_ERROR_CODES.CLASSIFIER_ERROR,
      'classifier_unavailable',
    );
  }
  return {
    decision: result.decision,
    category: result.category,
    reason: result.reason,
    confidence: result.confidence,
    degraded: result.degraded === true,
    errorCode: result.errorCode ?? null,
  };
}

/**
 * Compose hard rules, fast rules, classifier context, session state, and audit
 * into one decision for a new user message. Tool-loop steps must not call
 * `evaluate`; the DSH adapter is responsible for invoking it only for a new
 * user message.
 */
export function createGate({
  ruleSet,
  classifier,
  sessionStore = createSessionStateStore(),
  audit,
  refusalText,
  failOpen = true,
  contextTurns = DEFAULT_CONTEXT_TURNS,
} = {}) {
  if (ruleSet === null || typeof ruleSet !== 'object'
    || !Array.isArray(ruleSet.hardDeny) || !Array.isArray(ruleSet.fastAllow)) {
    throw new TypeError('ruleSet must contain hardDeny and fastAllow arrays');
  }
  if (classifier !== undefined
    && (classifier === null || typeof classifier.classify !== 'function')) {
    throw new TypeError('classifier must expose a classify function');
  }
  if (typeof refusalText !== 'string' || refusalText.length === 0) {
    throw new TypeError('refusalText must be a non-empty string');
  }
  if (typeof failOpen !== 'boolean') {
    throw new TypeError('failOpen must be a boolean');
  }

  const finalize = async ({
    started,
    sessionId,
    turn,
    kind,
    decision,
    category,
    reason,
    ruleId,
    confidence,
    degraded,
    errorCode,
    source,
    sessionState,
  }) => {
    const durationMs = Math.max(0, Date.now() - started);
    const result = Object.freeze({
      kind,
      decision,
      category,
      reason,
      ruleId,
      confidence,
      degraded,
      errorCode: errorCode ?? null,
      source,
      sessionState,
      refusalText: kind === 'reject' ? refusalText : null,
      durationMs,
    });

    if (typeof audit?.write === 'function') {
      try {
        await audit.write({
          timestamp: new Date().toISOString(),
          sessionId,
          turn: Number.isInteger(turn) ? turn : null,
          source,
          kind,
          decision,
          category,
          reason,
          ruleId,
          confidence,
          degraded,
          errorCode: errorCode ?? null,
          sessionState,
          durationMs,
        });
      } catch {
        // Audit failure must not change the gate decision.
      }
    }

    return result;
  };

  async function evaluate(input) {
    const started = Date.now();
    const sessionId = input?.sessionId;
    const turn = input?.turn;

    try {
      const currentState = sessionStore.get(sessionId);
      const ruleResult = evaluateRules(ruleSet, input.currentMessage);

      if (ruleResult.decision !== 'unknown') {
        const effective = sessionStore.apply(sessionId, ruleResult);
        const denied = effective.decision.decision === 'deny';
        return await finalize({
          started,
          sessionId,
          turn,
          kind: denied ? 'reject' : 'enter',
          decision: effective.decision.decision,
          category: effective.decision.category,
          reason: ruleResult.decision === 'deny'
            ? 'hard_deny'
            : denied ? 'continuation_blocked' : 'fast_allow',
          ruleId: ruleResult.ruleId,
          confidence: 1,
          degraded: false,
          errorCode: null,
          source: ruleResult.decision === 'deny' ? 'hard_deny' : 'fast_allow',
          sessionState: effective.state,
        });
      }

      let classifierResult;
      if (classifier === undefined) {
        classifierResult = degradedResult(
          GATE_ERROR_CODES.CLASSIFIER_UNAVAILABLE,
          'classifier_unavailable',
        );
      } else {
        try {
          const messages = buildClassifierMessages(
            { ...input, sessionState: currentState },
            { contextTurns },
          );
          classifierResult = await classifier.classify(messages);
        } catch {
          classifierResult = degradedResult(
            GATE_ERROR_CODES.CLASSIFIER_ERROR,
            'classifier_unavailable',
          );
        }
      }

      const normalized = normalizeClassifierResult(classifierResult);
      const effective = sessionStore.apply(sessionId, normalized);
      const effectiveDecision = effective.decision;
      const degraded = normalized.degraded || normalized.decision === 'unknown';
      const kind = effectiveDecision.decision === 'deny'
        ? 'reject'
        : effectiveDecision.decision === 'allow'
          ? 'enter'
          : failOpen ? 'enter' : 'reject';

      return await finalize({
        started,
        sessionId,
        turn,
        kind,
        decision: effectiveDecision.decision,
        category: effectiveDecision.category,
        reason: normalized.decision === 'allow'
          && normalized.category === 'D'
          && kind === 'reject' ? 'continuation_blocked' : effectiveDecision.reason,
        ruleId: null,
        confidence: effectiveDecision.confidence,
        degraded,
        errorCode: normalized.errorCode,
        source: normalized.degraded ? 'degraded' : 'classifier',
        sessionState: effective.state,
      });
    } catch {
      let sessionState = 'unknown';
      try {
        sessionStore.apply(sessionId, { decision: 'unknown', category: 'I' });
        sessionState = sessionStore.get(sessionId);
      } catch {
        // Fall through with the safe unknown state.
      }
      return await finalize({
        started,
        sessionId,
        turn,
        kind: failOpen ? 'enter' : 'reject',
        decision: 'unknown',
        category: 'I',
        reason: 'gate_error',
        ruleId: null,
        confidence: 0,
        degraded: true,
        errorCode: GATE_ERROR_CODES.GATE_ERROR,
        source: 'degraded',
        sessionState,
      });
    }
  }

  return Object.freeze({ evaluate });
}
