/**
 * Web client half of the MDT guard.
 *
 * The Host rejects out-of-scope turns before any model call, but a rejected
 * turn carries no response text and DSH's default Web Chat does not render
 * blocked turns. This client plugin fills `conversation.chat.turnTail` with the
 * fixed refusal notice when the turn ended with `{ kind: 'blocked' }`.
 *
 * The notice is plain UI text, never a fabricated model message: it uses the
 * PRD's fixed wording, is not persisted to the session log, and only appears
 * for turns that ended with `blocked`. DSH's turn-end reason does not name the
 * rejecting listener, so a block from another `agent/pre-step` listener would
 * also show this notice. Hosts that do not load client plugins (for example the
 * CLI) still block the turn; they just cannot show this notice. See
 * Docs/M1-refusal-notice.md.
 */

if (typeof globalThis.__ModuleLoader__?.load === 'function') {
  globalThis.__ModuleLoader__.load({
    id: '@local/dsh-mdt-guard',
    factory: (require) => {
      const module = { exports: {} };
      const exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      const { jsx } = require('react/jsx-runtime');

      const PLUGIN_ID = '@local/dsh-mdt-guard';

      /** PRD FR-5 fixed refusal text; must match the Host default. */
      const REFUSAL_TEXT =
        '本助手仅提供 MDT 多学科会诊相关支持，暂无法处理该请求。如需其他帮助，请联系信息科。';

      /**
       * Whether a conversation turn ended as blocked. The DSH protocol has no
       * field naming which pre-step listener rejected the turn, so this also
       * matches blocks from other listeners.
       */
      function isBlockedTurn(turn) {
        return turn?.end?.data?.reason?.kind === 'blocked';
      }

      function MdtRefusalNotice(props) {
        if (!isBlockedTurn(props?.turn)) return null;
        return jsx('div', {
          role: 'note',
          'data-mdt-guard': 'refusal',
          style: {
            margin: '8px 0',
            padding: '8px 12px',
            border: '1px solid rgba(127, 127, 127, 0.35)',
            borderRadius: '8px',
            color: 'inherit',
            fontSize: '13px',
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
          },
          children: REFUSAL_TEXT,
        });
      }

      const inject = ['slots'];

      function apply(ctx) {
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            // `conversation.chat.turnTail` is a list slot; DSH rejects a list
            // registration that has no id.
            { name: 'conversation.chat.turnTail', id: PLUGIN_ID },
            MdtRefusalNotice,
          ),
        );
      }

      exports.apply = apply;
      exports.inject = inject;
      exports.isBlockedTurn = isBlockedTurn;
      exports.REFUSAL_TEXT = REFUSAL_TEXT;
      return module.exports;
    },
  });
}
