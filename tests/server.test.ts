import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { DeviceGateway } from "../server/gateway.js";
import { oggToOpusPackets, opusPacketsToOgg } from "../server/ogg.js";
import { generateText, testProvider } from "../server/providers.js";
import { ConfigStore } from "../server/store.js";

test("provider API keys are encrypted and never returned in config", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "xiaopen-lite-"));
  try {
    const store = new ConfigStore(dataDir);
    await store.init();
    const provider = await store.saveProvider({
      name: "Local test",
      kind: "llm",
      driver: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "test-model",
      apiKey: "sk-super-secret-value",
    });

    assert.equal(provider.apiKeyStored, true);
    assert.equal(provider.apiKeyHint, "••••alue");
    assert.equal(await store.getProviderSecret(provider.id), "sk-super-secret-value");
    assert.doesNotMatch(JSON.stringify(store.getConfig()), /sk-super-secret-value/);
    assert.doesNotMatch(
      await readFile(join(dataDir, "vault.json"), "utf8"),
      /sk-super-secret-value/,
    );
    assert.equal((await stat(join(dataDir, "vault.key"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dataDir, "config.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("deleting a provider clears route references and its secret", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "xiaopen-lite-"));
  try {
    const store = new ConfigStore(dataDir);
    await store.init();
    const provider = await store.saveProvider({
      name: "Route test",
      kind: "llm",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "private",
    });
    await store.updateSettings({
      routes: {
        ...store.getConfig().routes,
        conversation: {
          ...store.getConfig().routes.conversation,
          llm: provider.id,
        },
        doorEvent: {
          ...store.getConfig().routes.doorEvent,
          llm: provider.id,
        },
      },
    });
    assert.equal(await store.deleteProvider(provider.id), true);
    assert.equal(store.getConfig().routes.conversation.llm, "");
    assert.equal(store.getConfig().routes.doorEvent.llm, "");
    assert.equal(await store.getProviderSecret(provider.id), "");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("provider connection test uses the encrypted API key", async () => {
  let authorization = "";
  const mock = createServer((request, response) => {
    authorization = request.headers.authorization ?? "";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "mock-chat" }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address();
  assert.ok(address && typeof address === "object");
  const dataDir = await mkdtemp(join(tmpdir(), "xiaopen-lite-"));
  try {
    const store = new ConfigStore(dataDir);
    await store.init();
    const provider = await store.saveProvider({
      name: "Mock cloud",
      kind: "llm",
      location: "cloud",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "mock-chat",
      apiKey: "sk-encrypted-test",
    });
    const result = await testProvider(store, provider);
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ["mock-chat"]);
    assert.equal(authorization, "Bearer sk-encrypted-test");
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("default privacy policy blocks text from reaching a cloud LLM", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "xiaopen-lite-"));
  try {
    const store = new ConfigStore(dataDir);
    await store.init();
    const provider = await store.saveProvider({
      name: "Blocked cloud",
      kind: "llm",
      location: "cloud",
      baseUrl: "https://api.example.test/v1",
      model: "cloud-chat",
      apiKey: "never-sent",
    });
    await assert.rejects(
      generateText(store, provider.id, "system", "private transcript"),
      /隐私策略禁止/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("raw Opus packets survive Ogg packaging", () => {
  const packets = [
    Buffer.from([0xf8, 0xff, 0xfe]),
    Buffer.from([0x48, 0x11, 0x22, 0x33]),
  ];
  const ogg = opusPacketsToOgg(packets, 16000, 60);
  assert.equal(ogg.subarray(0, 4).toString("ascii"), "OggS");
  assert.deepEqual(oggToOpusPackets(ogg), packets);
});

test("device gateway authenticates and answers the Xiaozhi hello handshake", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "xiaopen-lite-"));
  const store = new ConfigStore(dataDir);
  await store.init();
  const gateway = new DeviceGateway(store, 0);
  const server = await gateway.start();
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const token = await store.ensureDeviceToken();
  const unauthenticatedOta = await fetch(
    `http://127.0.0.1:${address.port}/xiaozhi/ota/`,
  );
  assert.equal(unauthenticatedOta.status, 401);
  const authenticatedOta = await fetch(
    `http://127.0.0.1:${address.port}/xiaozhi/ota/`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(authenticatedOta.status, 200);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/xiaozhi/v1/`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Device-Id": "test-s3",
      "Client-Id": "integration-test",
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "hello", transport: "websocket" }));
    const response = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(data.toString()));
      socket.once("error", reject);
    });
    const hello = JSON.parse(response) as {
      type: string;
      transport: string;
      audio_params: { sample_rate: number };
    };
    assert.equal(hello.type, "hello");
    assert.equal(hello.transport, "websocket");
    assert.equal(hello.audio_params.sample_rate, 24000);
    assert.equal(gateway.snapshot().connections[0]?.deviceId, "test-s3");
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("door event runs local LLM and TTS routes then streams Opus to the device", async () => {
  const spokenText = "丸子快开门，你爸带着主角光环回来了！";
  const ttsOgg = opusPacketsToOgg(
    [Buffer.from([0xf8, 0xff, 0xfe]), Buffer.from([0x48, 0x11, 0x22])],
    24000,
    60,
  );
  const modelServer = createServer((request, response) => {
    if (request.url?.endsWith("/chat/completions")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ choices: [{ message: { content: spokenText } }] }),
      );
      return;
    }
    if (request.url?.endsWith("/audio/speech")) {
      response.writeHead(200, { "Content-Type": "audio/ogg" });
      response.end(ttsOgg);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) =>
    modelServer.listen(0, "127.0.0.1", resolve),
  );
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === "object");
  const dataDir = await mkdtemp(join(tmpdir(), "xiaopen-lite-"));
  const store = new ConfigStore(dataDir);
  await store.init();
  const llm = await store.saveProvider({
    name: "Local LLM",
    kind: "llm",
    location: "local",
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
    model: "local-chat",
  });
  const tts = await store.saveProvider({
    name: "Local TTS",
    kind: "tts",
    location: "local",
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
    model: "local-voice",
    voice: "xiaopen",
  });
  await store.updateSettings({
    routes: {
      ...store.getConfig().routes,
      doorEvent: { llm: llm.id, tts: tts.id },
    },
  });
  const gateway = new DeviceGateway(store, 0);
  const server = await gateway.start();
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const token = await store.ensureDeviceToken();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/xiaozhi/v1/`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Device-Id": "door-speaker",
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "hello", transport: "websocket" }));
    await new Promise<void>((resolve, reject) => {
      socket.once("message", () => resolve());
      socket.once("error", reject);
    });
    const received: Array<{ binary: boolean; value: string | Buffer }> = [];
    socket.on("message", (data, isBinary) => {
      received.push({
        binary: isBinary,
        value: isBinary ? Buffer.from(data as Buffer) : data.toString(),
      });
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ identity: "dad", deviceId: "door-speaker" }),
      },
    );
    assert.equal(response.status, 202);
    assert.ok(
      received.some(
        (item) =>
          !item.binary &&
          String(item.value).includes("sentence_start") &&
          String(item.value).includes(spokenText),
      ),
    );
    assert.equal(
      received.filter((item) => item.binary).length,
      oggToOpusPackets(ttsOgg).length,
    );
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.close();
      });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
