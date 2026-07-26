import { ConfigStore } from "./store.js";
import { ProviderConfig } from "./types.js";

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  models?: string[];
}

const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const headersFor = (key: string): HeadersInit => ({
  Accept: "application/json",
  ...(key ? { Authorization: `Bearer ${key}` } : {}),
});

export async function testProvider(
  store: ConfigStore,
  provider: ProviderConfig,
): Promise<ProviderTestResult> {
  const started = performance.now();
  const key = await store.getProviderSecret(provider.id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);
  try {
    const endpoint =
      provider.driver === "ollama"
        ? joinUrl(provider.baseUrl, "api/tags")
        : joinUrl(provider.baseUrl, "models");
    const response = await fetch(endpoint, {
      method: "GET",
      headers: headersFor(key),
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    const body = (await response.json().catch(() => null)) as
      | {
          data?: Array<{ id?: string }>;
          models?: Array<{ name?: string; model?: string }>;
          error?: { message?: string } | string;
        }
      | null;
    if (!response.ok) {
      const detail =
        typeof body?.error === "string"
          ? body.error
          : body?.error?.message ?? `HTTP ${response.status}`;
      return {
        ok: false,
        latencyMs,
        message: `连接成功，但服务返回 ${detail}`,
      };
    }
    const models =
      body?.data
        ?.map((item) => item.id ?? "")
        .filter(Boolean)
        .slice(0, 20) ??
      body?.models
        ?.map((item) => item.name ?? item.model ?? "")
        .filter(Boolean)
        .slice(0, 20) ??
      [];
    return {
      ok: true,
      latencyMs,
      message: models.length
        ? `连接正常，发现 ${models.length} 个模型`
        : "连接正常",
      models,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    return {
      ok: false,
      latencyMs,
      message:
        error instanceof Error && error.name === "AbortError"
          ? "连接超时"
          : error instanceof Error
            ? error.message
            : "连接失败",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateText(
  store: ConfigStore,
  providerId: string,
  system: string,
  user: string,
): Promise<string> {
  const provider = store.getProvider(providerId);
  if (!provider || provider.kind !== "llm" || !provider.enabled) {
    throw new Error("没有可用的 LLM Provider");
  }
  const config = store.getConfig();
  if (
    provider.location === "cloud" &&
    !config.privacy.allowCloudTranscripts
  ) {
    throw new Error("隐私策略禁止向云端 LLM 发送文字");
  }
  const key = await store.getProviderSecret(provider.id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);
  try {
    const endpoint =
      provider.driver === "ollama"
        ? joinUrl(provider.baseUrl, "api/chat")
        : joinUrl(provider.baseUrl, "chat/completions");
    const payload =
      provider.driver === "ollama"
        ? {
            model: provider.model,
            stream: false,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }
        : {
            model: provider.model,
            stream: false,
            temperature: 0.9,
            max_tokens: 120,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...headersFor(key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as
      | {
          message?: { content?: string };
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string };
        }
      | null;
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `LLM HTTP ${response.status}`);
    }
    const text =
      body?.message?.content ?? body?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      throw new Error("LLM 没有返回文本");
    }
    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeAudio(
  store: ConfigStore,
  providerId: string,
  ogg: Buffer,
): Promise<string> {
  const provider = store.getProvider(providerId);
  if (!provider || provider.kind !== "asr" || !provider.enabled) {
    throw new Error("没有可用的 ASR Provider");
  }
  const config = store.getConfig();
  if (provider.location === "cloud" && !config.privacy.allowCloudAudio) {
    throw new Error("隐私策略禁止向云端 ASR 发送原始音频");
  }
  const key = await store.getProviderSecret(provider.id);
  const form = new FormData();
  form.append(
    "file",
    new Blob([Uint8Array.from(ogg)], { type: "audio/ogg" }),
    "speech.ogg",
  );
  form.append("model", provider.model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);
  try {
    const response = await fetch(
      joinUrl(provider.baseUrl, "audio/transcriptions"),
      {
        method: "POST",
        headers: headersFor(key),
        body: form,
        signal: controller.signal,
      },
    );
    const body = (await response.json().catch(() => null)) as
      | { text?: string; error?: { message?: string } }
      | null;
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `ASR HTTP ${response.status}`);
    }
    if (!body?.text?.trim()) {
      throw new Error("ASR 没有返回文字");
    }
    return body.text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

export async function synthesizeSpeech(
  store: ConfigStore,
  providerId: string,
  text: string,
): Promise<Buffer> {
  const provider = store.getProvider(providerId);
  if (!provider || provider.kind !== "tts" || !provider.enabled) {
    throw new Error("没有可用的 TTS Provider");
  }
  const config = store.getConfig();
  if (
    provider.location === "cloud" &&
    !config.privacy.allowCloudTranscripts
  ) {
    throw new Error("隐私策略禁止向云端 TTS 发送文本");
  }
  const key = await store.getProviderSecret(provider.id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);
  try {
    const response = await fetch(joinUrl(provider.baseUrl, "audio/speech"), {
      method: "POST",
      headers: {
        ...headersFor(key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        voice: provider.voice || "alloy",
        input: text,
        response_format: "opus",
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      throw new Error(body?.error?.message ?? `TTS HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
