import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const classifierResult = {
  decision: 'allow',
  category: 'A',
  reason: 'In-scope test request.',
  confidence: 0.95,
};

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server, sockets) {
  for (const socket of sockets) {
    socket.destroy();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function createMockGateway({
  keyPath,
  serverKeyPath,
  certPath,
  serverCertPath,
  mode = 'success',
  delayMs = 3500,
}) {
  const key = serverKeyPath ?? keyPath;
  const cert = serverCertPath ?? certPath;
  if (!key || !cert) {
    throw new Error('Mock HTTPS gateway requires a test server key and certificate.');
  }
  if (!['success', 'malformed', 'delay'].includes(mode)) {
    throw new Error(`Unsupported mock gateway mode: ${mode}`);
  }

  const requests = [];
  let completionCount = 0;
  const requestWaiters = [];
  const completionWaiters = [];

  const notifyWaiters = (waiters, count) => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (count >= waiters[i].target) {
        waiters.splice(i, 1)[0].resolve();
      }
    }
  };
  const waitForCount = (waiters, current, target) => {
    if (current >= target) {
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push({ target, resolve }));
  };

  const handleRequest = async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Request body must be JSON.' }));
      return;
    }

    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    notifyWaiters(requestWaiters, requests.length);

    if (request.url !== '/v1/chat/completions') {
      completionCount += 1;
      notifyWaiters(completionWaiters, completionCount);
      response.writeHead(404);
      response.end();
      return;
    }

    if (mode === 'delay') {
      await delay(delayMs);
    }

    const content = mode === 'malformed'
      ? '{not-json'
      : JSON.stringify(classifierResult);
    const envelope = {
      choices: [{ message: { role: 'assistant', content } }],
    };

    completionCount += 1;
    notifyWaiters(completionWaiters, completionCount);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(envelope));
  };

  const [keyData, certData] = await Promise.all([readFile(key), readFile(cert)]);
  const serverOptions = { key: keyData, cert: certData };
  const httpServer = createHttpServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      response.destroy(error);
    });
  });
  const httpsServer = createHttpsServer(serverOptions, (request, response) => {
    handleRequest(request, response).catch((error) => {
      response.destroy(error);
    });
  });
  const httpSockets = trackSockets(httpServer);
  const httpsSockets = trackSockets(httpsServer);

  let httpPort;
  let httpsPort;
  try {
    httpPort = await listen(httpServer);
    httpsPort = await listen(httpsServer);
  } catch (error) {
    await Promise.all([
      httpServer.listening ? closeServer(httpServer, httpSockets) : Promise.resolve(),
      httpsServer.listening ? closeServer(httpsServer, httpsSockets) : Promise.resolve(),
    ]);
    throw error;
  }

  return {
    httpUrl: `http://127.0.0.1:${httpPort}/v1/chat/completions`,
    httpsUrl: `https://localhost:${httpsPort}/v1/chat/completions`,
    httpPort,
    httpsPort,
    requests,
    get requestCount() {
      return requests.length;
    },
    waitForRequests: (count) => waitForCount(requestWaiters, requests.length, count),
    waitForCompletions: (count) => waitForCount(completionWaiters, completionCount, count),
    close: async () => {
      await Promise.all([
        closeServer(httpServer, httpSockets),
        closeServer(httpsServer, httpsSockets),
      ]);
    },
  };
}

export async function createConnectProxy({ originPort }) {
  if (!Number.isInteger(originPort) || originPort < 1 || originPort > 65535) {
    throw new Error('CONNECT proxy requires a valid local origin port.');
  }

  const connectAuthorities = [];
  const sockets = new Set();
  const server = createHttpServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, clientSocket, head) => {
    connectAuthorities.push(request.url);
    const allowedAuthorities = new Set([
      `localhost:${originPort}`,
      `127.0.0.1:${originPort}`,
    ]);
    if (!allowedAuthorities.has(request.url)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    const upstreamSocket = createConnection({ host: '127.0.0.1', port: originPort });
    let tunnelEstablished = false;
    sockets.add(upstreamSocket);
    upstreamSocket.once('close', () => sockets.delete(upstreamSocket));
    upstreamSocket.once('connect', () => {
      if (clientSocket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      tunnelEstablished = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    upstreamSocket.once('error', () => {
      if (!clientSocket.destroyed && !tunnelEstablished) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      } else if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    });
    clientSocket.once('error', () => upstreamSocket.destroy());
    clientSocket.once('close', () => upstreamSocket.destroy());
  });

  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    connectAuthorities,
    close: () => closeServer(server, sockets),
  };
}
