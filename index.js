import { createJsonlAuditWriter } from './audit-log.js';
import { createClassifierClient } from './classifier-client.js';
import { loadConfig } from './config.js';
import { createGate } from './gate.js';
import { createPreStepHandler } from './pre-step.js';
import { compileRules } from './rules.js';

function createRuntime(config) {
  const audit = config.audit.enabled
    ? createJsonlAuditWriter({
      storeText: config.audit.storeText,
      retentionDays: config.audit.retentionDays,
    })
    : undefined;

  const gate = createGate({
    ruleSet: compileRules({
      hardDeny: config.hardDeny,
      fastAllow: config.fastAllow,
    }),
    classifier: createClassifierClient({ ...config.classifier }),
    audit,
    refusalText: config.refusalText,
    failOpen: config.failOpen,
    contextTurns: config.contextTurns,
  });

  return createPreStepHandler({ gate });
}

/**
 * Register the server-side MDT gate with the DSH Host.
 *
 * Configuration is loaded from the server-side file once and validated before
 * the first gated message. A disabled guard or an invalid configuration keeps
 * DSH's default behavior. Runtime failures fall through to the host default
 * decision as required by FR-10.
 */
export function apply(ctx, _config) {
  let runtimePromise;

  const reportInactive = (error) => {
    try {
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      const field = typeof error?.field === 'string' ? `, field ${error.field}` : '';
      ctx.logger?.warn(
        `dsh-mdt-guard: runtime initialization failed (${code}${field}); guard inactive`,
      );
    } catch {
      // Reporting is best-effort; the guard stays inactive either way.
    }
  };

  const loadRuntime = () => {
    runtimePromise ??= loadConfig()
      .then((config) => (config.enabled ? createRuntime(config) : undefined))
      .catch((error) => {
        reportInactive(error);
        return undefined;
      });
    return runtimePromise;
  };

  return ctx.on('agent/pre-step', async (payload, next) => {
    const runtime = await loadRuntime();
    if (runtime === undefined) return next();
    return runtime.handle(payload, next);
  });
}
