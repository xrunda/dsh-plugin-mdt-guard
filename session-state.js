/**
 * Pure session-scope state machine for the MDT guard.
 *
 * Callers apply one decision for each new user message. Tool-loop steps with
 * no new user message must not call `apply`, so they do not advance state.
 * This module performs no I/O, logging, or model calls.
 */

export const SESSION_STATE = Object.freeze({
  UNKNOWN: 'unknown',
  IN_SCOPE: 'in_scope',
  OUT_OF_SCOPE: 'out_of_scope',
});

const STATES = new Set(Object.values(SESSION_STATE));
const IN_SCOPE_CATEGORIES = new Set(['A', 'B']);
const STATE_PRESERVING_CATEGORIES = new Set(['C', 'D']);

function requireState(state) {
  if (!STATES.has(state)) {
    throw new TypeError('session state must be unknown, in_scope or out_of_scope');
  }
}

function requireDecision(decision) {
  if (decision === null || typeof decision !== 'object') {
    throw new TypeError('session decision must be an object');
  }
  if (!['allow', 'deny', 'unknown'].includes(decision.decision)) {
    throw new TypeError('session decision must be allow, deny or unknown');
  }
  if (decision.decision === 'allow' && !IN_SCOPE_CATEGORIES.has(decision.category)
    && !STATE_PRESERVING_CATEGORIES.has(decision.category)) {
    throw new TypeError('allow decision must have an A, B, C or D category');
  }
}

/**
 * Return the next state for a decision against the current state.
 *
 * `allow` A/B enters `in_scope`; `allow` C/D keeps the current state; `deny`
 * enters `out_of_scope`; `unknown` resets to `unknown` (fail-open).
 */
export function nextSessionState(currentState, decision) {
  requireState(currentState);
  requireDecision(decision);

  if (decision.decision === 'deny') {
    return SESSION_STATE.OUT_OF_SCOPE;
  }
  if (decision.decision === 'unknown') {
    return SESSION_STATE.UNKNOWN;
  }
  if (IN_SCOPE_CATEGORIES.has(decision.category)) {
    return SESSION_STATE.IN_SCOPE;
  }
  return currentState;
}

/**
 * Create an isolated state store keyed by session id.
 *
 * A continuation (D) in `out_of_scope` is returned as an effective deny and
 * keeps the session out of scope; every other allow keeps or enters scope as
 * defined by `nextSessionState`.
 */
export function createSessionStateStore() {
  const states = new Map();

  return Object.freeze({
    get(sessionId) {
      return states.get(sessionId) ?? SESSION_STATE.UNKNOWN;
    },

    apply(sessionId, decision) {
      requireDecision(decision);
      const current = states.get(sessionId) ?? SESSION_STATE.UNKNOWN;
      const effective = decision.decision === 'allow'
        && decision.category === 'D'
        && current === SESSION_STATE.OUT_OF_SCOPE
        ? Object.freeze({ ...decision, decision: 'deny' })
        : decision;
      const state = nextSessionState(current, effective);
      states.set(sessionId, state);
      return Object.freeze({ state, decision: effective });
    },

    reset(sessionId) {
      states.delete(sessionId);
    },
  });
}
