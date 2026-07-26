import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { URL } from "node:url";
import { OpusDecoder } from "opus-decoder";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import { ConfigStore } from "./store.js";
import {
  generateText,
  synthesizeSpeech,
  transcribeAudio,
} from "./providers.js";
import { oggToOpusPackets, opusPacketsToOgg } from "./ogg.js";

interface DeviceSession {
  id: string;
  deviceId: string;
  clientId: string;
  socket: WebSocket;
  packets: Buffer[];
  decoder: OpusDecoder<16000>;
  speechStarted: boolean;
  speechFrames: number;
  silentFrames: number;
  processing: boolean;
  connectedAt: string;
  lastSeenAt: string;
}

const DEVICE_OTA_PATH = "/xiaopen/ota/";
const DEVICE_WEBSOCKET_PATH = "/xiaopen/v1/";

export interface GatewaySnapshot {
  running: boolean;
  startedAt: string;
  connections: Array<{
    sessionId: string;
    deviceId: string;
    clientId: string;
    connectedAt: string;
    lastSeenAt: string;
  }>;
  lastError: string;
  lastTranscript: string;
  lastResponse: string;
}

export class DeviceGateway {
  private readonly sessions = new Map<string, DeviceSession>();
  private startedAt = "";
  private lastError = "";
  private lastTranscript = "";
  private lastResponse = "";

  constructor(
    private readonly store: ConfigStore,
    private readonly port: number,
  ) {}

  async start() {
    await this.store.ensureDeviceToken();
    const server = createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => {
        this.sendJson(response, 500, {
          error: error instanceof Error ? error.message : "网关错误",
        });
      });
    });
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", async (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const authorization = request.headers.authorization ?? "";
      const token = await this.store.ensureDeviceToken();
      if (
        url.pathname !== DEVICE_WEBSOCKET_PATH ||
        authorization.replace(/^Bearer\s+/i, "") !== token
      ) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket, request) => {
      this.acceptDevice(socket, request).catch((error) => {
        this.lastError = error instanceof Error ? error.message : "设备连接失败";
        socket.close(1011, "gateway error");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "0.0.0.0", () => resolve());
    });
    this.startedAt = new Date().toISOString();
    return server;
  }

  snapshot(): GatewaySnapshot {
    return {
      running: Boolean(this.startedAt),
      startedAt: this.startedAt,
      connections: [...this.sessions.values()].map((session) => ({
        sessionId: session.id,
        deviceId: session.deviceId,
        clientId: session.clientId,
        connectedAt: session.connectedAt,
        lastSeenAt: session.lastSeenAt,
      })),
      lastError: this.lastError,
      lastTranscript: this.lastTranscript,
      lastResponse: this.lastResponse,
    };
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/health") {
      this.sendJson(response, 200, this.snapshot());
      return;
    }
    if (
      url.pathname === DEVICE_OTA_PATH ||
      url.pathname === DEVICE_OTA_PATH.slice(0, -1)
    ) {
      const authorization = request.headers.authorization ?? "";
      const token = await this.store.ensureDeviceToken();
      const deviceId = String(request.headers["device-id"] ?? "");
      const clientId = String(request.headers["client-id"] ?? "");
      const hasDeviceIdentity =
        /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(deviceId) &&
        clientId.length >= 8 &&
        clientId.length <= 128;
      const hasToken =
        authorization.replace(/^Bearer\s+/i, "") === token;
      if (!hasToken && !hasDeviceIdentity) {
        this.sendJson(response, 401, {
          error: "需要设备身份或有效 Token",
        });
        return;
      }
      const host = this.getLanAddress();
      this.sendJson(response, 200, {
        websocket: {
          url: `ws://${host}:${this.port}${DEVICE_WEBSOCKET_PATH}`,
          token,
          version: 1,
        },
        server_time: {
          timestamp: Date.now(),
          timezone_offset: -new Date().getTimezoneOffset(),
        },
      });
      return;
    }
    if (url.pathname === "/events" && request.method === "POST") {
      const authorization = request.headers.authorization ?? "";
      const token = await this.store.ensureDeviceToken();
      if (authorization.replace(/^Bearer\s+/i, "") !== token) {
        this.sendJson(response, 401, { error: "设备 Token 无效" });
        return;
      }
      const body = await this.readJson(request);
      const identity = body.identity === "dad" ? "dad" : "stranger";
      const session = [...this.sessions.values()].find(
        (item) => !body.deviceId || item.deviceId === body.deviceId,
      );
      if (!session) {
        this.sendJson(response, 409, {
          error: "小喷当前没有连接设备网关，事件已拒绝",
        });
        return;
      }
      await this.processDoorEvent(session, identity);
      this.sendJson(response, 202, { ok: true, identity });
      return;
    }
    this.sendJson(response, 404, { error: "接口不存在" });
  }

  private async acceptDevice(
    socket: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    const decoder = new OpusDecoder({
      sampleRate: 16000,
      channels: 1,
      streamCount: 1,
      coupledStreamCount: 0,
      channelMappingTable: [0],
    });
    const now = new Date().toISOString();
    const session: DeviceSession = {
      id: randomUUID(),
      deviceId: String(request.headers["device-id"] ?? "unknown"),
      clientId: String(request.headers["client-id"] ?? ""),
      socket,
      packets: [],
      decoder,
      speechStarted: false,
      speechFrames: 0,
      silentFrames: 0,
      processing: false,
      connectedAt: now,
      lastSeenAt: now,
    };
    let ready = false;
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    const dispatch = (data: RawData, isBinary: boolean) => {
      session.lastSeenAt = new Date().toISOString();
      if (isBinary) {
        const packet = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        this.handleAudio(session, packet).catch((error) => {
          this.failSession(session, error);
        });
        return;
      }
      this.handleMessage(session, data.toString()).catch((error) => {
        this.failSession(session, error);
      });
    };
    socket.on("message", (data, isBinary) => {
      if (!ready) {
        pending.push({ data, isBinary });
        return;
      }
      dispatch(data, isBinary);
    });
    socket.on("close", () => {
      if (ready) {
        session.decoder.free();
      }
      this.sessions.delete(session.id);
      this.store
        .appendAudit("gateway.disconnected", "info", session.deviceId)
        .catch(() => {});
    });
    await decoder.ready;
    if (socket.readyState !== WebSocket.OPEN) {
      decoder.free();
      return;
    }
    this.sessions.set(session.id, session);
    await this.store.appendAudit(
      "gateway.connected",
      "success",
      session.deviceId,
    );
    ready = true;
    for (const message of pending.splice(0)) {
      dispatch(message.data, message.isBinary);
    }
  }

  private async handleMessage(
    session: DeviceSession,
    text: string,
  ): Promise<void> {
    const message = JSON.parse(text) as {
      type?: string;
      state?: string;
      mode?: string;
    };
    if (message.type === "hello") {
      session.socket.send(
        JSON.stringify({
          type: "hello",
          transport: "websocket",
          session_id: session.id,
          audio_params: {
            format: "opus",
            sample_rate: 24000,
            channels: 1,
            frame_duration: 60,
          },
        }),
      );
      return;
    }
    if (message.type === "listen" && message.state === "start") {
      session.packets = [];
      session.speechStarted = false;
      session.speechFrames = 0;
      session.silentFrames = 0;
      session.processing = false;
      await session.decoder.reset();
      return;
    }
    if (
      message.type === "listen" &&
      message.state === "stop" &&
      session.packets.length
    ) {
      await this.processConversation(session);
    }
  }

  private async handleAudio(
    session: DeviceSession,
    packet: Buffer,
  ): Promise<void> {
    if (session.processing) {
      return;
    }
    session.packets.push(packet);
    if (session.packets.length > 400) {
      await this.processConversation(session);
      return;
    }
    const decoded = session.decoder.decodeFrame(packet);
    const samples = decoded.channelData[0];
    if (!samples?.length) {
      return;
    }
    let energy = 0;
    for (const sample of samples) {
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / samples.length);
    const speaking = rms > 0.018;
    if (speaking) {
      session.speechFrames += 1;
      session.silentFrames = 0;
      if (session.speechFrames >= 2) {
        session.speechStarted = true;
      }
    } else if (session.speechStarted) {
      session.silentFrames += 1;
      if (session.silentFrames >= 14 && session.speechFrames >= 4) {
        await this.processConversation(session);
      }
    }
  }

  private async processConversation(session: DeviceSession): Promise<void> {
    if (session.processing || !session.packets.length) {
      return;
    }
    session.processing = true;
    const config = this.store.getConfig();
    try {
      const ogg = opusPacketsToOgg(session.packets, 16000, 60);
      const transcript = await transcribeAudio(
        this.store,
        config.routes.conversation.asr,
        ogg,
      );
      this.lastTranscript = transcript;
      session.socket.send(
        JSON.stringify({
          session_id: session.id,
          type: "stt",
          text: transcript,
        }),
      );
      if (
        this.store.getProvider(config.routes.conversation.llm)?.location ===
          "cloud" &&
        !config.privacy.allowCloudTranscripts
      ) {
        throw new Error("隐私策略禁止向云端 LLM 发送转写文字");
      }
      const response = await generateText(
        this.store,
        config.routes.conversation.llm,
        config.prompts.assistant,
        transcript,
      );
      this.lastResponse = response;
      await this.speak(session, response, config.routes.conversation.tts);
      await this.store.appendAudit(
        "conversation.completed",
        "success",
        `${session.deviceId}: ${transcript.slice(0, 60)}`,
      );
    } catch (error) {
      this.failSession(session, error);
    } finally {
      session.packets = [];
      session.processing = false;
    }
  }

  private async processDoorEvent(
    session: DeviceSession,
    identity: "dad" | "stranger",
  ): Promise<void> {
    const config = this.store.getConfig();
    const prompt =
      identity === "dad" ? config.prompts.doorDad : config.prompts.doorStranger;
    const response = await generateText(
      this.store,
      config.routes.doorEvent.llm,
      config.prompts.assistant,
      prompt,
    );
    this.lastResponse = response;
    await this.speak(session, response, config.routes.doorEvent.tts);
    await this.store.appendAudit(
      "door.announced",
      "success",
      `${identity}: ${response.slice(0, 80)}`,
    );
  }

  private async speak(
    session: DeviceSession,
    text: string,
    providerId: string,
  ): Promise<void> {
    const ogg = await synthesizeSpeech(this.store, providerId, text);
    const packets = oggToOpusPackets(ogg);
    session.socket.send(
      JSON.stringify({
        session_id: session.id,
        type: "tts",
        state: "start",
      }),
    );
    session.socket.send(
      JSON.stringify({
        session_id: session.id,
        type: "tts",
        state: "sentence_start",
        text,
      }),
    );
    for (const packet of packets) {
      if (session.socket.readyState !== WebSocket.OPEN) {
        break;
      }
      session.socket.send(packet, { binary: true });
      await new Promise((resolve) => setTimeout(resolve, 55));
    }
    session.socket.send(
      JSON.stringify({
        session_id: session.id,
        type: "tts",
        state: "stop",
      }),
    );
  }

  private failSession(session: DeviceSession, error: unknown): void {
    const message = error instanceof Error ? error.message : "处理失败";
    this.lastError = message;
    session.socket.send(
      JSON.stringify({
        session_id: session.id,
        type: "alert",
        status: "error",
        message,
        emotion: "sad",
      }),
    );
    this.store
      .appendAudit("gateway.error", "error", `${session.deviceId}: ${message}`)
      .catch(() => {});
  }

  private getLanAddress(): string {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === "IPv4" && !address.internal) {
          return address.address;
        }
      }
    }
    return "127.0.0.1";
  }

  private async readJson(
    request: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
  ): void {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(body));
  }
}
