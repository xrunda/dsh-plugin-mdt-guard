import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function readRequiredText(relativePath) {
  const url = new URL(relativePath, import.meta.url);

  try {
    return await readFile(url, 'utf8');
  } catch (error) {
    assert.fail(`${relativePath} must exist and be readable: ${error.message}`);
  }
}

test('package manifest defines the private ESM bundle contract', async () => {
  const manifest = JSON.parse(await readRequiredText('../package.json'));

  assert.equal(manifest.name, '@local/dsh-mdt-guard');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.exports?.['.'], './index.js');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');

  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(manifest[field] ?? {}, {}, `${field} must not declare runtime dependencies`);
  }
  const installLifecycleScripts = [
    'preinstall',
    'install',
    'postinstall',
    'prepublish',
    'preprepare',
    'prepare',
    'postprepare',
  ];
  assert.deepEqual(
    Object.keys(manifest.scripts ?? {}).filter((script) => installLifecycleScripts.includes(script)),
    [],
    'install lifecycle scripts are not allowed',
  );

  const files = manifest.files;
  assert.ok(Array.isArray(files), 'files must be a package allowlist');
  for (const requiredPath of [
    'cordis.patch.yml',
    'index.js',
    'types/contracts.d.ts',
    'icon.svg',
  ]) {
    assert.ok(files.includes(requiredPath), `files must include ${requiredPath}`);
  }
  for (const localePath of ['locale/en.json', 'locale/zh.json']) {
    assert.ok(
      files.includes(localePath) || files.includes('locale'),
      `files must include ${localePath} directly or through the locale directory`,
    );
  }

  assert.equal(manifest.exports?.['./config'], './config.js');
  assert.equal(manifest.exports?.['./rules'], './rules.js');
  // rule-defaults.js is a transitive import of both config.js and rules.js,
  // so it must ship.
  for (const requiredPath of [
    'config.js',
    'rules.js',
    'rule-defaults.js',
    'pre-step.js',
    'tool-policy.js',
    'sandbox-guard.js',
  ]) {
    assert.ok(files.includes(requiredPath), `files must include ${requiredPath}`);
  }
  for (const entry of files) {
    // Normalize leading slash forms ("./" and bare "/", including
    // duplicates) so entries like "./Docs" or "//tests/foo" cannot slip into
    // the package allowlist.
    const normalized = entry.replace(/^(?:\.?\/)+/, '');
    assert.ok(
      !/^(?:Docs|tests)(?:\/|$)/.test(normalized),
      `files must not include ${entry}`,
    );
  }

  const rules = await import('@local/dsh-mdt-guard/rules');
  assert.equal(typeof rules.compileRules, 'function');
  assert.equal(typeof rules.evaluateRules, 'function');
});

test('bundle patch registers one empty MDT guard plugin row', async () => {
  const patch = await readRequiredText('../cordis.patch.yml');
  const ids = [...patch.matchAll(/^\s*-\s+id:\s*['"]?([^'"#\s]+)['"]?\s*$/gm)]
    .map((match) => match[1]);

  assert.deepEqual(ids, ['dsh-mdt-guard']);
  const rows = patch.split(/^(?=\s*-\s+id:)/m).filter((row) => /^\s*-\s+id:/.test(row));
  assert.equal(rows.length, 1, 'patch must contain exactly one plugin row');
  const [row] = rows;
  assert.match(row, /^\s*-\s+id:\s*['"]?dsh-mdt-guard['"]?\s*$/m);
  assert.match(row, /^\s+name:\s*['"]@local\/dsh-mdt-guard['"]\s*$/m);
  assert.match(row, /^\s+config:\s*\{\s*\}\s*$/m);
});

test('localized metadata and package icon are present and local', async () => {
  const manifest = JSON.parse(await readRequiredText('../package.json'));
  const english = JSON.parse(await readRequiredText('../locale/en.json'));
  const chinese = JSON.parse(await readRequiredText('../locale/zh.json'));
  const iconPath = manifest.dsh?.bundle?.icon ?? manifest.exports?.['./icon'];
  const icon = await readRequiredText('../icon.svg');

  for (const [locale, metadata] of [
    ['English', english.meta],
    ['Chinese', chinese.meta],
  ]) {
    assert.equal(typeof metadata?.title, 'string', `${locale} metadata must have a title`);
    assert.ok(metadata.title.trim().length > 0, `${locale} title must not be empty`);
    assert.equal(typeof metadata?.description, 'string', `${locale} metadata must have a description`);
    assert.ok(metadata.description.trim().length > 0, `${locale} description must not be empty`);
  }

  assert.equal(iconPath, './icon.svg', 'package icon path must be local');
  assert.match(icon, /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i, 'icon source must have an SVG root');
  assert.doesNotMatch(
    icon,
    /(?:href\s*=\s*["']\s*(?:https?:|\/\/)|url\s*\(\s*["']?\s*(?:https?:|\/\/)|@import\s+(?:url\()?["']?\s*(?:https?:|\/\/))/i,
    'icon must not reference external URLs',
  );
});

test('plugin entry declares host services and registers its listeners', async () => {
  const plugin = await import('../index.js');
  const registrations = [];
  const guards = [];
  let listenerDisposals = 0;
  let guardDisposals = 0;
  const disposer = () => {
    listenerDisposals += 1;
  };
  const config = new Proxy({}, {
    get(_target, property) {
      throw new Error(`unexpected config access: ${String(property)}`);
    },
  });
  const context = {
    agents: { list: () => [] },
    tools: {
      schemas: () => [],
      guard(guard) {
        guards.push(guard);
        return () => {
          guardDisposals += 1;
        };
      },
    },
    logger: { warn() {} },
    on(event, listener) {
      registrations.push({ event, listener });
      return disposer;
    },
  };

  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['agents', 'tools']);
  const pluginDisposer = plugin.apply(context, config);
  assert.equal(guards.length, 1, 'the file path guard must be registered');
  assert.equal(guards[0]({}), undefined, 'the guard fails open without host state');
  assert.deepEqual(
    registrations.map(({ event }) => event),
    ['agent/pre-step', 'agent/created'],
  );
  for (const { listener } of registrations) {
    assert.equal(typeof listener, 'function');
  }

  assert.equal(typeof pluginDisposer, 'function');
  pluginDisposer();
  assert.equal(listenerDisposals, 1);
  assert.equal(guardDisposals, 1);
});

test('plugin restricts existing and newly created agents from server configuration', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mdt-guard-tools-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configDir = join(home, '.dsh', 'mdt');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'guard.json'),
    JSON.stringify({
      enabled: true,
      classifier: {
        baseUrl: 'https://classifier.example.invalid/v1',
        model: 'mdt-classifier-example',
      },
      tools: { allow: ['read'], deny: ['bash'], enforce: true },
    }),
  );

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const plugin = await import('../index.js');
    const registrations = [];
    const existing = makeRestrictedAgent();
    const created = makeRestrictedAgent();
    const context = {
      agents: { list: () => [existing] },
      tools: {
        schemas: () => [{ name: 'read' }, { name: 'bash' }, { name: 'web_fetch' }],
      },
      logger: { warn() {} },
      on(event, listener) {
        registrations.push({ event, listener });
        return () => {};
      },
    };

    plugin.apply(context, {});
    await waitFor(() => existing.restrictions.length === 1);

    assert.deepEqual(existing.restrictions, [{ allow: ['read'], deny: ['bash'] }]);

    const createdListener = registrations.find(({ event }) => event === 'agent/created');
    await createdListener.listener({ agent: created });
    assert.deepEqual(created.restrictions, [{ allow: ['read'], deny: ['bash'] }]);
  } finally {
    process.env.HOME = originalHome;
  }
});

function makeRestrictedAgent() {
  const restrictions = [];
  return {
    restrictions,
    ctx: {
      tools: {
        restrict(filter) {
          restrictions.push(filter);
          return () => {};
        },
      },
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for asynchronous plugin installation');
}

test('declaration file includes the approved structural contracts', async () => {
  const contracts = await readRequiredText('../types/contracts.d.ts');
  const compact = (value) => value.replace(/\s+/g, ' ').trim();

  for (const declaration of [
    "export type SessionState = 'in_scope' | 'out_of_scope' | 'unknown';",
    "export type Category = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';",
    "export type Decision = 'allow' | 'deny' | 'unknown';",
    `export interface GateInput {
      sessionId: string;
      currentMessage: string;
      recentMessages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
      sessionState: SessionState;
      attachmentTypes?: ReadonlyArray<string>;
      turn?: number;
    }`,
    `export interface GateDecision {
      decision: Decision;
      category: Category;
      reason: string;
      confidence: number;
    }`,
    `export interface ConfigProvider<TConfig> {
      load(): Promise<TConfig>;
    }`,
    `export interface AuditWriter<TEvent> {
      write(event: TEvent, context?: { messageText?: string }): Promise<void>;
    }`,
  ]) {
    assert.ok(
      compact(contracts).includes(compact(declaration)),
      `declaration file must include ${declaration.split('\n')[0]}`,
    );
  }
});
