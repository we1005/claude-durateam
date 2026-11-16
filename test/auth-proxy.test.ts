import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { request } from "node:http";
import { startAuthProxy } from "../src/engines/auth-proxy.js";

function call(url: string, token: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("credential-injecting auth proxy", () => {
  it("injects the real token upstream and never returns it to the client", async () => {
    const realToken = `SYNTH-REAL-${Math.random().toString(16).slice(2)}`;
    let seenAuth = "";
    const upstream = createServer((req, res) => {
      seenAuth = String(req.headers["authorization"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no upstream port");
    const proxy = await startAuthProxy({ targetBaseUrl: `http://127.0.0.1:${address.port}/api/coding`, token: realToken });
    try {
      const ok = await call(`${proxy.baseUrl}/v1/messages`, proxy.dummyToken, "{}");
      expect(ok.status).toBe(200);
      expect(seenAuth).toBe(`Bearer ${realToken}`);
      expect(ok.text).not.toContain(realToken);
      const rejected = await call(`${proxy.baseUrl}/v1/messages`, "wrong-token", "{}");
      expect(rejected.status).toBe(401);
      expect(rejected.text).not.toContain(realToken);
      const notFound = await call(`${proxy.baseUrl}/other`, proxy.dummyToken, "{}");
      expect(notFound.status).toBe(404);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
