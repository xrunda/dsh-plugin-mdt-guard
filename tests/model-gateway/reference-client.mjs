import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';

// This transport exists only to exercise the protocol contract in tests.
const decisions = new Set(['allow', 'deny', 'unknown']);
const categories = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
const classifierFields = ['category', 'confidence', 'decision', 'reason'];

export class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Classifier request timed out after ${timeoutMs} ms.`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function parseClassifierResponse(statusCode, chunks) {
  const responseBody = Buffer.concat(chunks).toString('utf8');
  if (statusCode !== 200) {
    throw new Error(`Classifier gateway returned HTTP ${statusCode}.`);
  }

  let envelope;
  try {
    envelope = JSON.parse(responseBody);
  } catch (cause) {
    throw new Error('Classifier gateway response is not valid JSON.', { cause });
  }
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Classifier gateway response is missing message content.');
  }

  let result;
  try {
    result = JSON.parse(content);
  } catch (cause) {
    throw new Error('Classifier content is not valid JSON.', { cause });
  }

  if (
    result === null
    || typeof result !== 'object'
    || Array.isArray(result)
    || Object.keys(result).sort().join(',') !== classifierFields.join(',')
    || !decisions.has(result.decision)
    || !categories.has(result.category)
    || typeof result.reason !== 'string'
    || typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence)
    || result.confidence < 0
    || result.confidence > 1
  ) {
    throw new Error('Classifier content does not match the required schema.');
  }

  return result;
}

export function postChatCompletion({
  url,
  body,
  timeoutMs = 1500,
  ca,
  proxyUrl,
}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error(`Unsupported classifier URL protocol: ${target.protocol}`);
  }
  if (proxyUrl && target.protocol !== 'https:') {
    throw new Error('The CONNECT proxy fixture only supports HTTPS classifier URLs.');
  }
  if (proxyUrl && new URL(proxyUrl).protocol !== 'http:') {
    throw new Error('The CONNECT proxy URL must use HTTP.');
  }
  if (
    body === null
    || typeof body !== 'object'
    || Array.isArray(body)
    || typeof body.model !== 'string'
    || body.model.length === 0
    || !Array.isArray(body.messages)
  ) {
    throw new Error('The request body must contain a model name and messages array.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number.');
  }

  const payload = JSON.stringify({
    ...body,
    temperature: 0,
    max_tokens: 200,
  });
  const requestOptions = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
    rejectUnauthorized: true,
  };
  if (ca !== undefined) {
    requestOptions.ca = ca;
  }

  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    let activeRequest;
    let tunnel;
    let tlsSocket;
    let tunnelAgent;

    const cleanup = () => {
      activeRequest?.destroy();
      tunnelAgent?.destroy();
      tlsSocket?.destroy();
      tunnel?.destroy();
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    };
    const succeed = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      tunnelAgent?.destroy();
      resolve(result);
    };
    const readResponse = (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', fail);
      response.once('end', () => {
        try {
          succeed(parseClassifierResponse(response.statusCode, chunks));
        } catch (error) {
          fail(error);
        }
      });
    };
    const sendHttpsRequest = (agent) => {
      activeRequest = httpsRequest(target, { ...requestOptions, agent }, readResponse);
      activeRequest.once('error', fail);
      activeRequest.end(payload);
    };

    timer = setTimeout(() => fail(new RequestTimeoutError(timeoutMs)), timeoutMs);

    if (!proxyUrl) {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      activeRequest = send(target, requestOptions, readResponse);
      activeRequest.once('error', fail);
      activeRequest.end(payload);
      return;
    }

    const proxy = new URL(proxyUrl);
    const proxyRequest = httpRequest(proxy, {
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: { host: `${target.hostname}:${target.port || 443}` },
    });
    activeRequest = proxyRequest;
    proxyRequest.once('error', fail);
    proxyRequest.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        fail(new Error(`CONNECT proxy returned HTTP ${response.statusCode}.`));
        return;
      }

      activeRequest = undefined;
      tunnel = socket;
      if (head.length > 0) {
        tunnel.unshift(head);
      }

      const tlsOptions = {
        socket: tunnel,
        rejectUnauthorized: true,
        checkServerIdentity: (_serverName, certificate) =>
          checkServerIdentity(target.hostname, certificate),
      };
      if (isIP(target.hostname) === 0) {
        tlsOptions.servername = target.hostname;
      }
      if (ca !== undefined) {
        tlsOptions.ca = ca;
      }

      tlsSocket = tlsConnect(tlsOptions);
      tlsSocket.once('error', fail);
      tlsSocket.once('secureConnect', () => {
        if (settled) {
          tlsSocket.destroy();
          return;
        }
        tunnelAgent = new HttpsAgent({ keepAlive: false });
        tunnelAgent.createConnection = () => tlsSocket;
        sendHttpsRequest(tunnelAgent);
      });
    });
    proxyRequest.end();
  });
}
