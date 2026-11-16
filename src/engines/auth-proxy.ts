/**
 * Loopback credential-injecting proxy for sandboxed-bash runs.
 *
 * The Claude Code process (and therefore Bash) never receives the real API
 * token: it gets a bridge-minted dummy token and a 127.0.0.1 base URL. The
 * proxy replaces the Authorization header with the real token read from the
 * operator key file at startup, then streams the upstream response unchanged.
 * The real token is not logged or returned to the client.
 *
 * Hardening contract:
 * - Only POST to <target>/v1/messages and <target>/v1/messages/count_tokens is
 *   forwarded upstream (query flags such as ?beta=true are preserved). Every
 *   other method or path is rejected locally and never reaches the upstream.
 * - Request paths are decoded iteratively and checked for dot segments,
 *   backslashes and control characters, so encoded traversal (`%2e%2e`,
 *   `%2F`, ...) cannot pivot to another upstream path.
 * - The upstream target must be https, or plain http bound to a loopback
 *   address (test-only); otherwise startAuthProxy rejects.
 * - Client disconnects destroy the upstream request/socket promptly; upstream
 *   failures never write into a closed client response and never leak the
 *   request body.
 * - The metadata observer is wrapped: callback failures are contained and
 *   observation buffering is capped (metadata only, streaming is unaffected).
 *
 * Residual: Bash can see the dummy token/base URL and therefore spend quota
 * through the proxy, but cannot read the real credential.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";

export interface AuthProxyHandle {
  baseUrl: string;
  dummyToken: string;
  close(): Promise<void>;
}

export interface AuthProxyOptions {
  targetBaseUrl: string;
  token: string;
  /** Test-only upstream override (e.g. a local http server). */
  targetProtocol?: "http" | "https";
  /**
   * Max request bytes buffered for metadata observation only (streaming is
   * never buffered). Default 8 MiB, hard-clamped to 16 MiB.
   */
  observationMaxBytes?: number;
  /** Metadata only: never exposes headers, prompts, tool arguments, full URLs, queries or responses. */
  onRequestMetadata?: (metadata: {
    model: string | null;
    effort: string | null;
    thinkingType: string | null;
    stream: boolean | null;
    /** Fixed enum derived from the normalized route only: never a raw path/URL. */
    endpoint: "messages" | "count_tokens" | "unknown";
    /**
     * Distinguishes unavailable metadata from absent fields: "parsed" when the
     * observation body was within cap and valid JSON, "overflow" when the body
     * exceeded observationMaxBytes (fields null by design), "invalid" when the
     * body was not parseable JSON (fields null by design).
     */
    observedStatus: "parsed" | "overflow" | "invalid";
  }) => void;
}

export type AuthProxyRequestMetadata = Parameters<NonNullable<AuthProxyOptions["onRequestMetadata"]>>[0];

interface RequestMetadata extends AuthProxyRequestMetadata {}

const NULL_METADATA_FIELDS = { model: null, effort: null, thinkingType: null, stream: null } as const;
/** Default cap for buffering request bytes for metadata observation only; streaming is never buffered. */
const DEFAULT_OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;
/** Hard upper bound for the configurable observation cap. */
const MAX_OBSERVATION_MAX_BYTES = 16 * 1024 * 1024;
/** Headers never forwarded upstream (credentials replaced, hop-by-hop dropped). */
const STRIPPED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
]);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Normalizes a raw request target (origin-form, e.g. "/v1/messages?beta=true").
 * Returns null when the path is not a safe origin-form path: absolute-form
 * URIs, backslashes, control characters, malformed or layered percent
 * encoding, and any "." or ".." segment (before or after decoding) are
 * rejected so traversal to other upstream paths is impossible.
 */
function normalizeRequestTarget(rawUrl: string): { path: string; query: string } | null {
  if (!rawUrl || !rawUrl.startsWith("/")) return null;
  const queryStart = rawUrl.indexOf("?");
  const rawPath = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = queryStart === -1 ? "" : rawUrl.slice(queryStart);
  if (rawPath.includes("\\") || /[\0\r\n]/.test(rawPath) || /[\0\r\n ]/.test(query)) return null;
  let decoded = rawPath;
  for (let round = 0; round < 3 && decoded.includes("%"); round++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }
  if (/%2e|%5c|%0d|%0a|%00/i.test(decoded)) return null;
  if (/[\0\r\n\\]/.test(decoded)) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return { path: decoded, query };
}

export async function startAuthProxy(options: AuthProxyOptions): Promise<AuthProxyHandle> {
  const token = options.token;
  const dummyToken = `cdt-proxy-${randomBytes(18).toString("base64url")}`;
  const target = new URL(options.targetBaseUrl);
  const targetProtocol = options.targetProtocol ?? target.protocol.replace(":", "");
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(`auth proxy target protocol not allowed: ${target.protocol}`);
  }
  if (targetProtocol !== "http" && targetProtocol !== "https") {
    throw new Error(`auth proxy target protocol not allowed: ${targetProtocol}`);
  }
  if (targetProtocol === "http" && !isLoopbackHost(target.hostname)) {
    throw new Error("auth proxy plain-http upstream is only allowed on loopback (test use)");
  }
  const targetPath = target.pathname.replace(/\/+$/, "");
  const allowedUpstreamPaths = new Set([`${targetPath}/v1/messages`, `${targetPath}/v1/messages/count_tokens`]);
  const sockets = new Set<Socket>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let clientGone = false;
    res.on("error", () => {});
    res.on("close", () => {
      clientGone = true;
    });
    try {
      const auth = req.headers["authorization"];
      const apiKey = req.headers["x-api-key"];
      const presented = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : typeof apiKey === "string" ? apiKey : "";
      if (presented !== dummyToken) {
        req.resume();
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "proxy token rejected" } }));
        return;
      }
      if (req.method !== "POST") {
        req.resume();
        res.writeHead(405, { allow: "POST", "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_allowed_error", message: "proxy method not allowed" } }));
        return;
      }
      const normalized = normalizeRequestTarget(req.url ?? "");
      const upstreamPath = normalized ? `${targetPath}${normalized.path}${normalized.query}` : null;
      if (!upstreamPath || !allowedUpstreamPaths.has(`${targetPath}${normalized!.path}`)) {
        req.resume();
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found", message: "proxy path not allowed" } }));
        return;
      }
      // Fixed enum derived from the normalized route only (never raw path/query/URL).
      const endpoint: AuthProxyRequestMetadata["endpoint"] = normalized!.path === "/v1/messages/count_tokens" ? "count_tokens" : "messages";
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (STRIPPED_HEADERS.has(lower)) continue;
        headers[lower] = value;
      }
      headers["authorization"] = `Bearer ${token}`;
      headers["host"] = target.host;

      const observe = options.onRequestMetadata
        ? (metadata: RequestMetadata) => {
            try {
              options.onRequestMetadata?.(metadata);
            } catch {
              // Observer failures are contained: they must never crash the
              // proxy process via unhandled emits nor affect the response.
            }
          }
        : undefined;
      if (observe) {
        const requestedCap = options.observationMaxBytes ?? DEFAULT_OBSERVATION_MAX_BYTES;
        const observationCap = Math.min(
          requestedCap > 0 ? Math.floor(requestedCap) : DEFAULT_OBSERVATION_MAX_BYTES,
          MAX_OBSERVATION_MAX_BYTES,
        );
        const buildMetadata = (body: unknown, observedStatus: RequestMetadata["observedStatus"]): RequestMetadata => {
          if (!body || typeof body !== "object") return { ...NULL_METADATA_FIELDS, endpoint, observedStatus };
          const record = body as {
            model?: unknown;
            output_config?: { effort?: unknown };
            reasoning_effort?: unknown;
            thinking?: { type?: unknown };
            stream?: unknown;
          };
          return {
            model: typeof record.model === "string" ? record.model : null,
            effort: typeof record.output_config?.effort === "string" ? record.output_config.effort : typeof record.reasoning_effort === "string" ? record.reasoning_effort : null,
            thinkingType: typeof record.thinking?.type === "string" ? record.thinking.type : null,
            stream: typeof record.stream === "boolean" ? record.stream : null,
            endpoint,
            observedStatus,
          };
        };
        const chunks: Buffer[] = [];
        let buffered = 0;
        let overflow = false;
        req.on("data", (chunk: Buffer) => {
          buffered += chunk.length;
          if (buffered > observationCap) {
            overflow = true;
            chunks.length = 0;
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        req.on("end", () => {
          try {
            if (overflow) {
              observe(buildMetadata(null, "overflow"));
              return;
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            observe(buildMetadata(body, "parsed"));
          } catch {
            observe(buildMetadata(null, "invalid"));
          } finally {
            chunks.length = 0;
          }
        });
        req.on("close", () => {
          chunks.length = 0;
        });
      }

      const requestFn = targetProtocol === "https" ? httpsRequest : httpRequest;
      const upstream = requestFn(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: req.method,
          path: upstreamPath,
          headers,
          timeout: 300_000,
        },
        (upstreamRes) => {
          if (res.writableEnded || res.destroyed || clientGone) {
            upstreamRes.destroy();
            return;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          res.flushHeaders();
          upstreamRes.pipe(res);
          upstreamRes.on("error", () => {
            if (!res.writableEnded) res.destroy();
          });
        },
      );
      upstream.on("socket", (socket: Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      upstream.on("timeout", () => upstream.destroy(new Error("proxy upstream timeout")));
      upstream.on("error", () => {
        if (res.writableEnded || res.destroyed || clientGone) return;
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: "upstream request failed" } }));
        } else {
          res.end();
        }
      });
      // Client disconnect must reclaim the upstream socket promptly.
      const teardownUpstream = () => upstream.destroy();
      req.on("error", teardownUpstream);
      req.on("close", () => {
        if (!req.readableEnded) teardownUpstream();
      });
      res.on("close", () => {
        if (!res.writableEnded) teardownUpstream();
      });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: "proxy failure" } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
  server.on("clientError", (err, socket) => {
    void err;
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("auth proxy failed to bind loopback port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dummyToken,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
