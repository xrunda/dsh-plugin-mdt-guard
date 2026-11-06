import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';

import {
  SANDBOX_PROTECTED_DENIED,
  SANDBOX_WORKSPACE_DENIED,
  checkToolAccess,
  createSandboxGuard,
} from '../sandbox-guard.js';

const HOME = '/home/doctor';
const WORKSPACE = '/work/mdt-session';
const SANDBOX = { enforce: true, denyPaths: ['~/.dsh', '/root'] };
const identityRealpath = (value) => value;

function check(toolName, args, overrides = {}) {
  return checkToolAccess({
    toolName,
    args,
    workspace: WORKSPACE,
    sandbox: SANDBOX,
    home: HOME,
    realpath: identityRealpath,
    ...overrides,
  });
}

test('allows a relative file path inside the session workspace', () => {
  assert.equal(check('read', { file_path: 'notes/case.md' }), undefined);
});

test('normalizes parent segments that stay inside the workspace', () => {
  assert.equal(check('read', { file_path: 'notes/../case.md' }), undefined);
  assert.equal(check('read', { file_path: `${WORKSPACE}/notes/../case.md` }), undefined);
});

test('allows tools whose path argument defaults to the workspace', () => {
  assert.equal(check('glob', { pattern: '**/*.md' }), undefined);
  assert.equal(check('grep', { pattern: 'diagnosis' }), undefined);
});

test('resolves relative paths against the effective working directory', () => {
  // A session may `cd` away from its workspace; the fs tools then resolve
  // relative arguments against the new directory.
  assert.equal(
    check('read', { file_path: 'passwd' }, { workingDirectory: '/etc' }),
    SANDBOX_WORKSPACE_DENIED,
  );
  assert.equal(
    check('read', { file_path: 'case.md' }, { workingDirectory: `${WORKSPACE}/notes` }),
    undefined,
  );
  // Absolute paths stay inside the workspace regardless of the directory.
  assert.equal(
    check('read', { file_path: `${WORKSPACE}/case.md` }, { workingDirectory: '/etc' }),
    undefined,
  );
});

test('checks the implicit directory of glob and grep', () => {
  assert.equal(
    check('glob', { pattern: '**/*' }, { workingDirectory: '/etc' }),
    SANDBOX_WORKSPACE_DENIED,
  );
  assert.equal(
    check('grep', { pattern: 'token' }, { workingDirectory: '/root' }),
    SANDBOX_PROTECTED_DENIED,
  );
});

test('resolves relative protected roots against the workspace', () => {
  assert.equal(
    check(
      'read',
      { file_path: 'sensitive/cert.pem' },
      { sandbox: { enforce: true, denyPaths: ['sensitive'] } },
    ),
    SANDBOX_PROTECTED_DENIED,
  );
});

test('denies an absolute path outside the workspace', () => {
  assert.equal(
    check('read', { file_path: '/work/other-session/case.md' }),
    SANDBOX_WORKSPACE_DENIED,
  );
});

test('denies relative path traversal out of the workspace', () => {
  assert.equal(check('read', { file_path: '../../etc/passwd' }), SANDBOX_WORKSPACE_DENIED);
});

test('denies a protected path even when it is inside the workspace', () => {
  assert.equal(
    check('read', { file_path: `${HOME}/.dsh/mdt/guard.json` }, { workspace: HOME }),
    SANDBOX_PROTECTED_DENIED,
  );
});

test('expands a home-relative protected path', () => {
  assert.equal(
    check('read', { file_path: '~/.dsh/mdt/guard.json' }),
    SANDBOX_PROTECTED_DENIED,
  );
});

test('checks every mapped file tool and a generic path argument', () => {
  for (const [toolName, args] of [
    ['write', { file_path: '/etc/hosts', content: 'x' }],
    ['edit', { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' }],
    ['read_image', { file_path: '/etc/hosts' }],
    ['str_replace_editor', { command: 'view', path: '/etc/hosts' }],
    ['unknown_tool', { file_path: '/etc/hosts' }],
  ]) {
    assert.equal(check(toolName, args), SANDBOX_WORKSPACE_DENIED, toolName);
  }
});

test('a denial reason never echoes the requested path', () => {
  const reason = check('read', { file_path: '/secret/patient-list.csv' });
  assert.equal(reason, SANDBOX_WORKSPACE_DENIED);
  assert.doesNotMatch(reason, /secret|patient-list/);
});

test('symlinks that escape the workspace are denied', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mdt-guard-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(outside, join(workspace, 'escape'));
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code}`);
    return;
  }

  assert.equal(
    checkToolAccess({
      toolName: 'read',
      args: { file_path: join(workspace, 'escape', 'secret.txt') },
      workspace,
      sandbox: SANDBOX,
      home: HOME,
    }),
    SANDBOX_WORKSPACE_DENIED,
  );
});

test('a parent segment after a symlink cannot escape the workspace', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows collapses ".." lexically; POSIX resolves it physically');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-mdt-guard-dotdot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  // Lexical resolution of `escape/..` stays inside the workspace; physical
  // resolution follows the symlink and lands here.
  await writeFile(join(workspace, 'secret.txt'), 'inside');
  await writeFile(join(root, 'secret.txt'), 'outside');
  try {
    await symlink(outside, join(workspace, 'escape'));
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code}`);
    return;
  }

  for (const requested of [
    `${workspace}${sep}escape${sep}..${sep}secret.txt`,
    `escape${sep}..${sep}secret.txt`,
  ]) {
    assert.equal(
      checkToolAccess({
        toolName: 'read',
        args: { file_path: requested },
        workspace,
        sandbox: SANDBOX,
        home: HOME,
      }),
      SANDBOX_WORKSPACE_DENIED,
      requested,
    );
  }
});

test('a symlinked workspace spelling does not cause false denials', async (t) => {
  if (process.platform === 'win32') {
    t.skip('requires a POSIX symlink');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-mdt-guard-symlink-ws-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  const link = join(root, 'link');
  await mkdir(real, { recursive: true });
  try {
    await symlink(real, link);
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code}`);
    return;
  }

  // `header.cwd` keeps the symlink spelling; the effective directory is the
  // resolved one (as the working-directory service commits it).
  assert.equal(
    checkToolAccess({
      toolName: 'read',
      args: { file_path: 'case.md' },
      workspace: link,
      workingDirectory: real,
      sandbox: SANDBOX,
      home: HOME,
    }),
    undefined,
  );
});

test('missing files are checked through their nearest existing ancestor', async (t) => {
  if (process.platform === 'win32') {
    t.skip('requires a POSIX symlink');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-mdt-guard-ancestor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, join(workspace, 'escape'), 'dir');
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code}`);
    return;
  }

  // The parent directory does not exist yet; the existing ancestor is inside.
  assert.equal(
    checkToolAccess({
      toolName: 'write',
      args: { file_path: join(workspace, 'notes', 'new-file.txt'), content: 'x' },
      workspace,
      sandbox: SANDBOX,
      home: HOME,
    }),
    undefined,
  );
  // The nearest existing ancestor is a symlink that leaves the workspace.
  assert.equal(
    checkToolAccess({
      toolName: 'write',
      args: { file_path: join(workspace, 'escape', 'new-file.txt'), content: 'x' },
      workspace,
      sandbox: SANDBOX,
      home: HOME,
    }),
    SANDBOX_WORKSPACE_DENIED,
  );
});

test('case-insensitive protected roots are denied on case-insensitive filesystems', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('requires a case-insensitive filesystem');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-mdt-guard-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.dsh', 'mdt'), { recursive: true });
  await writeFile(join(root, '.dsh', 'mdt', 'guard.json'), '{}');

  try {
    const [lower, upper] = await Promise.all([
      stat(join(root, '.dsh')),
      stat(join(root, '.DSH')),
    ]);
    if (lower.ino !== upper.ino) throw new Error('different inode');
  } catch {
    t.skip('the temporary directory is case-sensitive');
    return;
  }

  assert.equal(
    checkToolAccess({
      toolName: 'read',
      args: { file_path: join(root, '.DSH', 'mdt', 'guard.json') },
      workspace: root,
      sandbox: SANDBOX,
      home: root,
    }),
    SANDBOX_PROTECTED_DENIED,
  );
});

test('a non-existent target is checked through its existing ancestor', () => {
  const realpath = (value) => {
    if (value.endsWith('/new-file.txt')) throw new Error('ENOENT');
    return value;
  };
  assert.equal(
    check('write', { file_path: '/work/other/new-file.txt' }, { realpath }),
    SANDBOX_WORKSPACE_DENIED,
  );
});

test('malformed arguments and tool calls fail open', () => {
  assert.equal(check('read', undefined), undefined);
  assert.equal(check('read', null), undefined);
  assert.equal(check('read', []), undefined);
  assert.equal(check('read', { file_path: 42 }), undefined);
  assert.equal(check('read', {}), undefined);
  assert.equal(check(undefined, { file_path: '/etc/hosts' }), undefined);
});

test('the guard is inactive when sandbox enforcement or the guard is disabled', () => {
  assert.equal(check('read', { file_path: '/etc/hosts' }, { sandbox: { enforce: false } }), undefined);

  const disabled = createSandboxGuard({ getConfig: () => ({ enabled: false, sandbox: SANDBOX }) });
  assert.equal(disabled({ agent: { session: { header: { cwd: WORKSPACE } } } }), undefined);

  const optingOut = createSandboxGuard({
    getConfig: () => ({ enabled: true, sandbox: { ...SANDBOX, enforce: false } }),
  });
  assert.equal(optingOut({ agent: { session: { header: { cwd: WORKSPACE } } } }), undefined);
});

test('the guard reads the workspace from the calling agent session', () => {
  const guard = createSandboxGuard({
    getConfig: () => ({ enabled: true, sandbox: SANDBOX }),
    home: HOME,
    realpath: identityRealpath,
  });

  assert.equal(
    guard({
      name: 'read',
      arguments: { file_path: '/etc/hosts' },
      agent: { session: { header: { cwd: WORKSPACE } } },
    }),
    SANDBOX_WORKSPACE_DENIED,
  );
  assert.equal(
    guard({
      name: 'read',
      arguments: { file_path: 'notes/case.md' },
      agent: { session: { header: { cwd: WORKSPACE } } },
    }),
    undefined,
  );
});

test('the guard reads the effective directory and root from host providers', () => {
  const withDirectory = createSandboxGuard({
    getConfig: () => ({ enabled: true, sandbox: SANDBOX }),
    getWorkingDirectory: () => '/etc',
    home: HOME,
    realpath: identityRealpath,
  });
  assert.equal(
    withDirectory({
      name: 'read',
      arguments: { file_path: 'passwd' },
      agent: { session: { header: { cwd: WORKSPACE } } },
    }),
    SANDBOX_WORKSPACE_DENIED,
  );

  // A session without a recorded cwd falls back to the host's workspace root.
  const withRoot = createSandboxGuard({
    getConfig: () => ({ enabled: true, sandbox: SANDBOX }),
    getWorkspaceRoot: () => WORKSPACE,
    home: HOME,
    realpath: identityRealpath,
  });
  assert.equal(
    withRoot({
      name: 'read',
      arguments: { file_path: '/etc/passwd' },
      agent: { session: { header: {} } },
    }),
    SANDBOX_WORKSPACE_DENIED,
  );
  assert.equal(
    withRoot({
      name: 'read',
      arguments: { file_path: 'notes/case.md' },
      agent: { session: { header: {} } },
    }),
    undefined,
  );
});

test('guard errors and missing runtime configuration fail open', () => {
  assert.equal(createSandboxGuard({ getConfig: () => undefined })({ name: 'read' }), undefined);
  assert.equal(
    createSandboxGuard({
      getConfig: () => {
        throw new Error('raw loader detail');
      },
    })({ name: 'read' }),
    undefined,
  );

  const guard = createSandboxGuard({
    getConfig: () => ({ enabled: true, sandbox: SANDBOX }),
    realpath: () => {
      throw new Error('raw filesystem detail');
    },
  });
  assert.equal(
    guard({
      name: 'read',
      arguments: { file_path: 'notes/case.md' },
      agent: { session: { header: { cwd: WORKSPACE } } },
    }),
    undefined,
  );
});
