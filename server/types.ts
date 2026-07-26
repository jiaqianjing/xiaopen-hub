export type ProviderKind = "llm" | "asr" | "tts" | "vision" | "embedding";
export type ProviderDriver =
  | "openai-compatible"
  | "ollama"
  | "custom-http";
export type ProviderLocation = "local" | "cloud";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  driver: ProviderDriver;
  location: ProviderLocation;
  baseUrl: string;
  model: string;
  voice: string;
  enabled: boolean;
  timeoutMs: number;
  apiKeyStored: boolean;
  apiKeyHint: string;
  createdAt: string;
  updatedAt: string;
}

export interface RouteConfig {
  asr: string;
  llm: string;
  tts: string;
}

export interface AppConfig {
  version: 1;
  providers: ProviderConfig[];
  routes: {
    conversation: RouteConfig;
    doorEvent: Pick<RouteConfig, "llm" | "tts">;
    vision: string;
    embedding: string;
  };
  prompts: {
    assistant: string;
    doorDad: string;
    doorStranger: string;
  };
  privacy: {
    allowCloudAudio: boolean;
    allowCloudImages: boolean;
    allowCloudTranscripts: boolean;
    retainTranscripts: boolean;
    auditEnabled: boolean;
  };
  gateway: {
    adminPort: number;
    devicePort: number;
    deviceTokenHint: string;
  };
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  outcome: "success" | "error" | "info";
  detail: string;
}

export interface ProviderInput {
  id?: string;
  name?: string;
  kind?: ProviderKind;
  driver?: ProviderDriver;
  location?: ProviderLocation;
  baseUrl?: string;
  model?: string;
  voice?: string;
  enabled?: boolean;
  timeoutMs?: number;
  apiKey?: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  providers: [],
  routes: {
    conversation: { asr: "", llm: "", tts: "" },
    doorEvent: { llm: "", tts: "" },
    vision: "",
    embedding: "",
  },
  prompts: {
    assistant:
      "你是小喷一号，一个住在家里的桌面伙伴。说话自然、简短、有温度，不编造自己看到或听到的内容。",
    doorDad:
      "爸爸回来了。请用一句俏皮、温暖、每次不同的话提醒丸子开门。不要解释，不超过40个汉字。",
    doorStranger:
      "门口出现陌生人。请用一句诙谐但明确的警戒话提醒小丸子不要开门。不要解释，不超过45个汉字。",
  },
  privacy: {
    allowCloudAudio: false,
    allowCloudImages: false,
    allowCloudTranscripts: false,
    retainTranscripts: false,
    auditEnabled: true,
  },
  gateway: {
    adminPort: 8090,
    devicePort: 8091,
    deviceTokenHint: "",
  },
  updatedAt: new Date(0).toISOString(),
};
