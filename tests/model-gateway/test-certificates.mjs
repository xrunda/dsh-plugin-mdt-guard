import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function createTestCertificates() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'mdt-classifier-test-'));
  const caCertPath = path.join(tempDir, 'ca-cert.pem');
  const caKeyPath = path.join(tempDir, 'ca-key.pem');
  const serverCertPath = path.join(tempDir, 'server-cert.pem');
  const serverKeyPath = path.join(tempDir, 'server-key.pem');
  const requestPath = path.join(tempDir, 'server.csr');
  const extensionPath = path.join(tempDir, 'server-ext.cnf');

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true });
  };
  const runOpenSSL = (args) => {
    try {
      execFileSync('openssl', args, { stdio: 'pipe', timeout: 15_000 });
    } catch (cause) {
      throw new Error(
        'Unable to generate test TLS certificates. Install OpenSSL and ensure it is available on PATH.',
        { cause },
      );
    }
  };

  try {
    runOpenSSL([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKeyPath,
      '-out',
      caCertPath,
      '-days',
      '1',
      '-subj',
      '/CN=MDT classifier test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    await chmod(caKeyPath, 0o600);

    runOpenSSL([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      serverKeyPath,
      '-out',
      requestPath,
      '-subj',
      '/CN=localhost',
    ]);
    await chmod(serverKeyPath, 0o600);

    await writeFile(
      extensionPath,
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n',
      { mode: 0o600 },
    );
    runOpenSSL([
      'x509',
      '-req',
      '-in',
      requestPath,
      '-CA',
      caCertPath,
      '-CAkey',
      caKeyPath,
      '-CAcreateserial',
      '-out',
      serverCertPath,
      '-days',
      '1',
      '-sha256',
      '-extfile',
      extensionPath,
    ]);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    caCertPath,
    caKeyPath,
    serverCertPath,
    serverKeyPath,
    tempDir,
    cleanup,
  };
}
