import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { ConfigStore } from "./store.js";
import { generateText, testProvider } from "./providers.js";
import { ProviderInput } from "./types.js";
import type { DeviceGateway } from "./gateway.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) {
      throw new Error("请求内容过大");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin ?? "";
  if (
    origin === "http://localhost:3000" ||
    origin === "http://127.0.0.1:3000"
  ) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS",
  );
}

export async function startAdminApi(
  store: ConfigStore,
  gateway?: DeviceGateway,
  port = Number(process.env.XIAOPEN_ADMIN_PORT ?? 8090),
) {
  const server = createServer(async (request, response) => {
    setCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          ok: true,
          service: "xiaopen-hub",
          version: "0.1.0",
          dataDir: store.dataDir,
          time: new Date().toISOString(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, store.getConfig());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/audit") {
        sendJson(
          response,
          200,
          await store.readAudit(Number(url.searchParams.get("limit") ?? 80)),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/gateway/status") {
        sendJson(response, 200, gateway?.snapshot() ?? { running: false });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/providers") {
        const provider = await store.saveProvider(
          (await readJson(request)) as ProviderInput,
        );
        await store.appendAudit(
          "provider.saved",
          "success",
          `${provider.kind}:${provider.name}`,
        );
        sendJson(response, 200, provider);
        return;
      }
      const providerMatch = url.pathname.match(
        /^\/api\/providers\/([^/]+)(?:\/(test))?$/,
      );
      if (providerMatch) {
        const id = decodeURIComponent(providerMatch[1]);
        if (request.method === "DELETE" && !providerMatch[2]) {
          const deleted = await store.deleteProvider(id);
          await store.appendAudit(
            "provider.deleted",
            deleted ? "success" : "error",
            id,
          );
          sendJson(response, deleted ? 200 : 404, { ok: deleted });
          return;
        }
        if (request.method === "POST" && providerMatch[2] === "test") {
          const provider = store.getProvider(id);
          if (!provider) {
            sendJson(response, 404, { error: "Provider 不存在" });
            return;
          }
          const result = await testProvider(store, provider);
          await store.appendAudit(
            "provider.tested",
            result.ok ? "success" : "error",
            `${provider.name}: ${result.message}`,
          );
          sendJson(response, result.ok ? 200 : 502, result);
          return;
        }
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const config = await store.updateSettings(
          (await readJson(request)) as Parameters<
            ConfigStore["updateSettings"]
          >[0],
        );
        await store.appendAudit("settings.updated", "success", "控制台设置");
        sendJson(response, 200, config);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/preview/door") {
        const body = (await readJson(request)) as { identity?: string };
        const config = store.getConfig();
        const isDad = body.identity === "dad";
        const prompt = isDad
          ? config.prompts.doorDad
          : config.prompts.doorStranger;
        const text = await generateText(
          store,
          config.routes.doorEvent.llm,
          config.prompts.assistant,
          prompt,
        );
        await store.appendAudit(
          "door.preview",
          "success",
          isDad ? "dad" : "stranger",
        );
        sendJson(response, 200, { text });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/gateway/token/rotate"
      ) {
        const result = await store.rotateDeviceToken();
        await store.appendAudit(
          "gateway.token_rotated",
          "success",
          result.hint,
        );
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: "接口不存在" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      await store.appendAudit("api.error", "error", message).catch(() => {});
      sendJson(response, 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}
