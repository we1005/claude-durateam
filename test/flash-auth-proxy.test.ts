import { describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { startAuthProxy } from "../src/engines/auth-proxy.js";

interface UpstreamHit {
  method: string;
  path: string;
}

/** Local upstream that records hits and can serve scripted SSE bodies. */
function startUpstream(): Promise<{
  port: number;
  hits: UpstreamHit[];
  close(): Promise<void>;
  scriptedBodies: Array<(req: IncomingMessage, res: ServerResponse) => void>;
}> {
  const hits: UpstreamHit[] = [];
  const scriptedBodies: Array<(req: IncomingMessage, res: ServerResponse) => void> = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? "", path: req.url ?? "" });
    const script = scriptedBodies.shift();
    if (script) {
      script(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no upstream port");
      resolve({
        port: address.port,
        hits,
        scriptedBodies,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function call(
  url: string,
  method: string,
  token: string,
  body: string,
): Promise<{ status: number; text: string; chunks: string[]; res?: import("node:http").IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } },
      (res) => {
        const chunks: string[] = [];
        res.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: chunks.join(""), chunks, res }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("hardened credential-injecting auth proxy", () => {
  it("forwards only POST /v1/messages and /v1/messages/count_tokens, rejecting everything else before upstream", async () => {
    const upstream = await startUpstream();
    const proxy = await startAuthProxy({ targetBaseUrl: `http://127.0.0.1:${upstream.port}/api/coding`, token: "SYNTH-REAL-1" });
    try {
      const allowed = await call(`${proxy.baseUrl}/v1/messages`, "POST", proxy.dummyToken, "{}");
      expect(allowed.status).toBe(200);
      const countTokens = await call(`${proxy.baseUrl}/v1/messages/count_tokens?beta=true`, "POST", proxy.dummyToken, "{}");
      expect(countTokens.status).toBe(200);

      const rejected: Array<[string, string, string]> = [
        ["/v1/messages", "GET", "{}"],
        ["/v1/messages", "PUT", "{}"],
        ["/v1/messages", "DELETE", "{}"],
        ["/v1/messages/count_tokens", "GET", ""],
        ["/v1/complete", "POST", "{}"],
        ["/v1/models", "POST", "{}"],
        ["/v1/messages/", "POST", "{}"],
        ["/v1/messages/../v1/complete", "POST", "{}"],
        ["/v1/messages/../../admin", "POST", "{}"],
        ["/v1/%2e%2e/v1/complete", "POST", "{}"],
        ["/v1/messages/%2e%2e/%2e%2e/secret", "POST", "{}"],
        ["//v1/messages", "POST", "{}"],
        ["/v1/messages%2f..%2f..%2fadmin", "POST", "{}"],
        ["/v1/messages/%252e%252e/admin", "POST", "{}"],
        ["/other", "POST", "{}"],
      ];
      for (const [path, method, body] of rejected) {
        const result = await call(`${proxy.baseUrl}${path}`, method, proxy.dummyToken, body);
        expect([404, 405], `${method} ${path}`).toContain(result.status);
        expect(result.text).not.toContain("SYNTH-REAL-1");
      }
      // Only the two allowed POSTs ever reached the upstream.
      expect(upstream.hits.map((hit) => `${hit.method} ${hit.path}`)).toEqual([
        "POST /api/coding/v1/messages",
        "POST /api/coding/v1/messages/count_tokens?beta=true",
      ]);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("streams SSE upstream responses through incrementally without buffering", async () => {
    const upstream = await startUpstream();
    upstream.scriptedBodies.push((req, res) => {
      void req;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
      setTimeout(() => {
        res.write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n");
        res.end();
      }, 40);
    });
    const proxy = await startAuthProxy({ targetBaseUrl: `http://127.0.0.1:${upstream.port}`, token: "SYNTH-REAL-2" });
    try {
      const result = await call(`${proxy.baseUrl}/v1/messages`, "POST", proxy.dummyToken, JSON.stringify({ model: "glm-5.3", stream: true }));
      expect(result.status).toBe(200);
      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
      expect(result.chunks[0]).toContain("message_start");
      expect(result.chunks[1]).toContain("content_block_delta");
      expect(result.text).not.toContain("SYNTH-REAL-2");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("replaces dummy auth with the real token upstream", async () => {
    const realToken = `SYNTH-REAL-${Math.random().toString(16).slice(2)}`;
    let seenAuth = "";
    const upstream = await startUpstream();
    upstream.scriptedBodies.push((req, res) => {
      seenAuth = String(req.headers["authorization"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const proxy = await startAuthProxy({ targetBaseUrl: `http://127.0.0.1:${upstream.port}`, token: realToken });
    try {
      const wrongToken = await call(`${proxy.baseUrl}/v1/messages`, "POST", "not-the-token", "{}");
      expect(wrongToken.status).toBe(401);
      const ok = await call(`${proxy.baseUrl}/v1/messages`, "POST", proxy.dummyToken, "{}");
      expect(ok.status).toBe(200);
      expect(seenAuth).toBe(`Bearer ${realToken}`);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("client cancellation destroys the upstream request and proxy close still settles", async () => {
    const upstream = await startUpstream();
    let upstreamClosed: (() => void) | undefined;
    const upstreamSawClose = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    upstream.scriptedBodies.push((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      const timer = setInterval(() => res.write("data: {\"tick\":true}\n\n"), 20);
      res.on("close", () => {
        clearInterval(timer);
        upstreamClosed?.();
      });
    });
    const proxy = await startAuthProxy({ targetBaseUrl: `http://127.0.0.1:${upstream.port}`, token: "SYNTH-REAL-3" });
    try {
      const clientReq = httpRequest(
        `${proxy.baseUrl}/v1/messages`,
        { method: "POST", headers: { authorization: `Bearer ${proxy.dummyToken}`, "content-type": "application/json" } },
        (res) => {
          let first = true;
          res.on("data", () => {
            if (first) {
              first = false;
              // Cancel mid-stream once the first SSE chunk has arrived.
              setTimeout(() => clientReq.destroy(), 10);
            }
          });
        },
      );
      clientReq.on("error", () => {});
      clientReq.end("{}");
      const closed = await Promise.race([upstreamSawClose.then(() => "closed"), new Promise((r) => setTimeout(() => r("timeout"), 1500))]);
      expect(closed).toBe("closed");
      // Awaited (Vitest 5 treats unawaited async assertions as errors) and idempotent.
      await expect(proxy.close()).resolves.toBeUndefined();
      await expect(proxy.close()).resolves.toBeUndefined();
    } finally {
      await upstream.close();
    }
  });

  it("close() is idempotent: repeated calls settle without throwing", async () => {
    const proxy = await startAuthProxy({ targetBaseUrl: "https://api.example.com/", token: "SYNTH-REAL-CLOSE" });
    await expect(proxy.close()).resolves.toBeUndefined();
    await expect(proxy.close()).resolves.toBeUndefined();
    await expect(proxy.close()).resolves.toBeUndefined();
  });

  it("observer failures never crash the proxy; normal >64KiB bodies still expose model metadata", async () => {
    const upstream = await startUpstream();
    const observed: Array<Record<string, unknown>> = [];
    const proxy = await startAuthProxy({
      targetBaseUrl: `http://127.0.0.1:${upstream.port}`,
      token: "SYNTH-REAL-4",
      onRequestMetadata: (metadata) => {
        observed.push({ ...metadata });
        if (observed.length === 1) throw new Error("observer blew up on purpose");
      },
    });
    try {
      const small = await call(`${proxy.baseUrl}/v1/messages`, "POST", proxy.dummyToken, JSON.stringify({ model: "glm-5.3", stream: true }));
      expect(small.status).toBe(200);
      // Ordinary large workload (>64KiB) must still parse, not degrade.
      const context = "x".repeat(128 * 1024);
      const large = await call(
        `${proxy.baseUrl}/v1/messages`,
        "POST",
        proxy.dummyToken,
        JSON.stringify({ model: "glm-5.3", reasoning_effort: "high", stream: true, context }),
      );
      expect(large.status).toBe(200);
      expect(observed.length).toBe(2);
      expect(observed[0]).toMatchObject({ model: "glm-5.3", stream: true, endpoint: "messages", observedStatus: "parsed" });
      expect(observed[1]).toMatchObject({
        model: "glm-5.3",
        effort: "high",
        stream: true,
        endpoint: "messages",
        observedStatus: "parsed",
      });
      // Raw body content never leaks through metadata.
      const serialized = JSON.stringify(observed);
      expect(serialized).not.toContain(context.slice(0, 64));
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("over-cap bodies report observedStatus overflow without affecting upstream forwarding", async () => {
    const upstream = await startUpstream();
    const observed: Array<Record<string, unknown>> = [];
    let upstreamSawPadding = false;
    upstream.scriptedBodies.push((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        upstreamSawPadding = body.includes("y".repeat(1024));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\ndata: {}\n\n");
        res.end();
      });
    });
    const proxy = await startAuthProxy({
      targetBaseUrl: `http://127.0.0.1:${upstream.port}`,
      token: "SYNTH-REAL-5",
      observationMaxBytes: 16 * 1024,
      onRequestMetadata: (metadata) => observed.push({ ...metadata }),
    });
    try {
      const padding = "y".repeat(32 * 1024);
      const result = await call(`${proxy.baseUrl}/v1/messages`, "POST", proxy.dummyToken, JSON.stringify({ model: "glm-5.3", padding }));
      expect(result.status).toBe(200);
      expect(result.text).toContain("message_start");
      // Streaming/forwarding unaffected by observation overflow.
      expect(upstreamSawPadding).toBe(true);
      expect(observed.length).toBe(1);
      expect(observed[0]).toMatchObject({
        model: null,
        effort: null,
        thinkingType: null,
        stream: null,
        endpoint: "messages",
        observedStatus: "overflow",
      });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("unparseable bodies report observedStatus invalid and still forward", async () => {
    const upstream = await startUpstream();
    const observed: Array<Record<string, unknown>> = [];
    const proxy = await startAuthProxy({
      targetBaseUrl: `http://127.0.0.1:${upstream.port}`,
      token: "SYNTH-REAL-6",
      onRequestMetadata: (metadata) => observed.push({ ...metadata }),
    });
    try {
      const result = await call(`${proxy.baseUrl}/v1/messages`, "POST", proxy.dummyToken, "not-json{");
      expect(result.status).toBe(200);
      expect(observed[0]).toMatchObject({ model: null, endpoint: "messages", observedStatus: "invalid" });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("validates target protocol: https anywhere, plain http only on loopback", async () => {
    await expect(startAuthProxy({ targetBaseUrl: "http://example.com/", token: "t" })).rejects.toThrow(/loopback/i);
    await expect(startAuthProxy({ targetBaseUrl: "ftp://example.com/", token: "t" })).rejects.toThrow(/protocol/i);
    const httpsHandle = await startAuthProxy({ targetBaseUrl: "https://api.example.com/", token: "t" });
    expect(httpsHandle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await httpsHandle.close();
  });
});
