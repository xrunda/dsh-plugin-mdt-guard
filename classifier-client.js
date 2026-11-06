import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';

const DECISIONS = new Set(['allow', 'deny', 'unknown']);
const CATEGORIES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
const RESULT_FIELDS = ['category', 'confidence', 'decision', 'reason'];
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_TOKENS = 200;

export const CLASSIFIER_ERROR_CODES = Object.freeze({
  TIMEOUT: 'CLASSIFIER_TIMEOUT',
  NETWORK: 'CLASSIFIER_NETWORK_ERROR',
  HTTP: 'CLASSIFIER_HTTP_ERROR',
  RESPONSE: 'CLASSIFIER_RESPONSE_INVALID',
  CA: 'CLASSIFIER_CA_UNAVAILABLE',
  INPUT: 'CLASSIFIER_INPUT_INVALID',
});

class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Classifier request timed out after ${timeoutMs} ms.`);
    this.name = 'RequestTimeoutError';
  }
}

class ClassifierProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClassifierProtocolError';
    this.code = code;
  }
}

function buildEndpoint(baseUrl) {
  let target;
  try {
    target = new URL(baseUrl);
  } catch {
    throw new TypeError('classifier.baseUrl must be an absolute HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new TypeError('classifier.baseUrl must use HTTP or HTTPS');
  }

  const path = target.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) {
    target.pathname = path;
  } else if (path === '') {
    target.pathname = '/v1/chat/completions';
  } else {
    target.pathname = `${path}/chat/completions`;
  }
  return target;
}

function validateOptions({
  baseUrl, model, timeoutMs, maxTokens, proxyUrl,
}) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('classifier.model must be a non-empty string');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('classifier.timeoutMs must be a positive finite number');
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new TypeError('classifier.maxTokens must be a positive integer');
  }
  if (proxyUrl !== undefined) {
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      throw new TypeError('classifier proxy must be an absolute HTTP URL');
    }
    if (proxy.protocol !== 'http:') {
      throw new TypeError('classifier proxy must use HTTP');
    }
  }
  return buildEndpoint(baseUrl);
}

function parseClassifierResponse(statusCode, body) {
  if (statusCode !== 200) {
    throw new ClassifierProtocolError(
      CLASSIFIER_ERROR_CODES.HTTP,
      'Classifier gateway returned a non-success status.',
    );
  }

  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new ClassifierProtocolError(
      CLASSIFIER_ERROR_CODES.RESPONSE,
      'Classifier gateway response is not valid JSON.',
    );
  }

  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new ClassifierProtocolError(
      CLASSIFIER_ERROR_CODES.RESPONSE,
      'Classifier gateway response is missing message content.',
    );
  }

  let result;
  try {
    result = JSON.parse(content);
  } catch {
    throw new ClassifierProtocolError(
      CLASSIFIER_ERROR_CODES.RESPONSE,
      'Classifier content is not valid JSON.',
    );
  }

  if (
    result === null
    || typeof result !== 'object'
    || Array.isArray(result)
    || Object.keys(result).sort().join(',') !== RESULT_FIELDS.join(',')
    || !DECISIONS.has(result.decision)
    || !CATEGORIES.has(result.category)
    || typeof result.reason !== 'string'
    || typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence)
    || result.confidence < 0
    || result.confidence > 1
  ) {
    throw new ClassifierProtocolError(
      CLASSIFIER_ERROR_CODES.RESPONSE,
      'Classifier content does not match the required schema.',
    );
  }

  return {
    decision: result.decision,
    category: result.category,
    reason: result.reason,
    confidence: result.confidence,
  };
}

function degradedResult(errorCode) {
  return Object.freeze({
    decision: 'unknown',
    category: 'I',
    reason: 'classifier_unavailable',
    confidence: 0,
    degraded: true,
    errorCode,
  });
}

/**
 * POST one chat completion request. The timeout covers connection, TLS, proxy,
 * response headers, and response body. A request is never retried.
 */
function postChatCompletion({
  target, payload, timeoutMs, ca, proxyUrl, apiKey,
}) {
  const requestOptions = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
    rejectUnauthorized: true,
  };
  if (apiKey !== undefined) {
    requestOptions.headers.authorization = `Bearer ${apiKey}`;
  }
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
    const succeed = (statusCode, chunks) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      tunnelAgent?.destroy();
      resolve({ statusCode, body: Buffer.concat(chunks).toString('utf8') });
    };
    const readResponse = (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', fail);
      response.once('end', () => succeed(response.statusCode, chunks));
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
    const authority = `${target.hostname}:${target.port || 443}`;
    const proxyRequest = httpRequest(proxy, {
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
    });
    activeRequest = proxyRequest;
    proxyRequest.once('error', fail);
    proxyRequest.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        fail(new ClassifierProtocolError(
          CLASSIFIER_ERROR_CODES.NETWORK,
          'Classifier proxy refused the connection.',
        ));
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

/**
 * Create an OpenAI-compatible classifier client.
 *
 * The caller supplies secrets from validated server-side configuration. The
 * client never logs, reads client-side settings, retries, or disables TLS
 * verification. Every classification failure is returned as a degraded
 * `unknown` result rather than thrown or shaped as a successful decision.
 */
export function createClassifierClient({
  baseUrl,
  model,
  apiKey,
  ca,
  caCertFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens = DEFAULT_MAX_TOKENS,
  proxyUrl,
} = {}) {
  const target = validateOptions({
    baseUrl, model, timeoutMs, maxTokens, proxyUrl,
  });
  if (proxyUrl !== undefined && target.protocol !== 'https:') {
    throw new TypeError('classifier proxy requires an HTTPS baseUrl');
  }

  let caPromise;
  const resolveCa = () => {
    if (ca !== undefined) {
      return Promise.resolve(ca);
    }
    if (caCertFile === undefined) {
      return Promise.resolve(undefined);
    }
    caPromise ??= readFile(caCertFile);
    return caPromise;
  };

  return Object.freeze({
    async classify(messages) {
      if (!Array.isArray(messages) || messages.length === 0) {
        return degradedResult(CLASSIFIER_ERROR_CODES.INPUT);
      }

      let resolvedCa;
      try {
        resolvedCa = await resolveCa();
      } catch {
        return degradedResult(CLASSIFIER_ERROR_CODES.CA);
      }

      const payload = JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
      });

      let response;
      try {
        response = await postChatCompletion({
          target,
          payload,
          timeoutMs,
          ca: resolvedCa,
          proxyUrl,
          apiKey,
        });
      } catch (error) {
        return degradedResult(
          error instanceof RequestTimeoutError
            ? CLASSIFIER_ERROR_CODES.TIMEOUT
            : CLASSIFIER_ERROR_CODES.NETWORK,
        );
      }

      try {
        return Object.freeze({
          ...parseClassifierResponse(response.statusCode, response.body),
          degraded: false,
        });
      } catch (error) {
        return degradedResult(
          error instanceof ClassifierProtocolError
            ? error.code
            : CLASSIFIER_ERROR_CODES.RESPONSE,
        );
      }
    },
  });
}
