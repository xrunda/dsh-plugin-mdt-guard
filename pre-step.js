/**
 * DSH `agent/pre-step` adapter for the MDT guard.
 *
 * The host calls this waterfall before every model step. Only batches that
 * contain new user-authored text are gated; tool-loop steps and injected
 * context pass through unchanged. A denied batch returns the host's reject
 * decision so the loop ends before any model request.
 *
 * DSH `PreStepDecision` has no field for refusal text, and the default Web
 * Chat does not render blocked turns as an error row. Therefore this adapter
 * blocks the turn but cannot itself display `config.refusalText`; a
 * host-supported blocked-turn presentation remains an unresolved adapter
 * boundary. See Docs/M0-plugin-hook-validation.md.
 */

function textOf(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function isUserAuthored(message) {
  return message?.role === 'user' && message?.source?.kind === 'user';
}

function attachmentTypesOf(message) {
  if (!Array.isArray(message?.content)) return [];
  const types = [];
  for (const block of message.content) {
    if ((block?.type === 'image' || block?.type === 'file') && !types.includes(block.type)) {
      types.push(block.type);
    }
  }
  return types;
}

function readHistory(session) {
  if (typeof session?.deriveMessages !== 'function') return [];
  const messages = session.deriveMessages();
  if (!Array.isArray(messages)) return [];

  const history = [];
  for (const message of messages) {
    if (message?.role === 'user') {
      if (!isUserAuthored(message)) continue;
    } else if (message?.role !== 'assistant') {
      continue;
    }
    const content = textOf(message);
    if (content !== '') history.push({ role: message.role, content });
  }
  return history;
}

/**
 * Create a `agent/pre-step` listener around an existing gate.
 *
 * Any adapter failure falls back to the host's default decision (`next()`),
 * matching FR-10's requirement that plugin errors must not break a session.
 *
 * @param {{ gate: { evaluate(input: object): Promise<object> } }} options
 */
export function createPreStepHandler({ gate } = {}) {
  if (gate === null || typeof gate !== 'object' || typeof gate.evaluate !== 'function') {
    throw new TypeError('gate must expose an evaluate function');
  }

  async function decide(payload) {
    const agent = payload?.agent;
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return undefined;
    }

    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const userMessages = messages.filter(isUserAuthored);
    if (userMessages.length === 0) {
      return undefined;
    }

    const attachmentTypes = [];
    for (const message of userMessages) {
      for (const type of attachmentTypesOf(message)) {
        if (!attachmentTypes.includes(type)) attachmentTypes.push(type);
      }
    }

    return gate.evaluate({
      sessionId,
      currentMessage: userMessages.map(textOf).filter((text) => text !== '').join('\n'),
      recentMessages: readHistory(agent.session),
      sessionState: 'unknown',
      attachmentTypes,
      turn: payload.turn,
    });
  }

  async function handle(payload, next) {
    let outcome;
    try {
      outcome = await decide(payload);
    } catch {
      return next();
    }
    return outcome?.kind === 'reject' ? { kind: 'reject' } : next();
  }

  return Object.freeze({ handle });
}
