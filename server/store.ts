import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  AppConfig,
  AuditEntry,
  DEFAULT_CONFIG,
  ProviderConfig,
  ProviderInput,
} from "./types.js";

interface EncryptedSecret {
  iv: string;
  tag: string;
  value: string;
}

interface VaultFile {
  version: 1;
  secrets: Record<string, EncryptedSecret>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class ConfigStore {
  readonly dataDir: string;
  private readonly configPath: string;
  private readonly auditPath: string;
  private readonly keyPath: string;
  private readonly vaultPath: string;
  private config: AppConfig = clone(DEFAULT_CONFIG);
  private key: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private vault: VaultFile = { version: 1, secrets: {} };

  constructor(dataDir?: string) {
    this.dataDir =
      dataDir ??
      process.env.XIAOPEN_DATA_DIR ??
      join(homedir(), ".xiaopen-lite");
    this.configPath = join(this.dataDir, "config.json");
    this.auditPath = join(this.dataDir, "audit.jsonl");
    this.keyPath = join(this.dataDir, "vault.key");
    this.vaultPath = join(this.dataDir, "vault.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    this.key = await this.loadOrCreateKey();
    this.config = await this.loadJson<AppConfig>(
      this.configPath,
      clone(DEFAULT_CONFIG),
    );
    this.vault = await this.loadJson<VaultFile>(this.vaultPath, {
      version: 1,
      secrets: {},
    });
    await this.writeConfig();
    await this.writeVault();
  }

  getConfig(): AppConfig {
    return clone(this.config);
  }

  getProvider(id: string): ProviderConfig | undefined {
    const provider = this.config.providers.find((item) => item.id === id);
    return provider ? clone(provider) : undefined;
  }

  async saveProvider(input: ProviderInput): Promise<ProviderConfig> {
    const now = new Date().toISOString();
    const existing = input.id
      ? this.config.providers.find((item) => item.id === input.id)
      : undefined;
    const id = existing?.id ?? randomUUID();
    const baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? "").trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error("Base URL 必须以 http:// 或 https:// 开头");
    }
    const provider: ProviderConfig = {
      id,
      name: String(input.name ?? existing?.name ?? "").trim(),
      kind: input.kind ?? existing?.kind ?? "llm",
      driver: input.driver ?? existing?.driver ?? "openai-compatible",
      location: input.location ?? existing?.location ?? "local",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      model: String(input.model ?? existing?.model ?? "").trim(),
      voice: String(input.voice ?? existing?.voice ?? "alloy").trim(),
      enabled: input.enabled ?? existing?.enabled ?? true,
      timeoutMs: Math.min(
        120_000,
        Math.max(1_000, Number(input.timeoutMs ?? existing?.timeoutMs ?? 20_000)),
      ),
      apiKeyStored: existing?.apiKeyStored ?? false,
      apiKeyHint: existing?.apiKeyHint ?? "",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!provider.name) {
      throw new Error("请输入 Provider 名称");
    }
    if (input.apiKey?.trim()) {
      const key = input.apiKey.trim();
      await this.setSecret(`provider:${id}`, key);
      provider.apiKeyStored = true;
      provider.apiKeyHint = key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
    }
    const index = this.config.providers.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.config.providers[index] = provider;
    } else {
      this.config.providers.push(provider);
    }
    this.config.updatedAt = now;
    await this.writeConfig();
    return clone(provider);
  }

  async deleteProvider(id: string): Promise<boolean> {
    const before = this.config.providers.length;
    this.config.providers = this.config.providers.filter(
      (item) => item.id !== id,
    );
    if (this.config.providers.length === before) {
      return false;
    }
    await this.deleteSecret(`provider:${id}`);
    const clear = (value: string) => (value === id ? "" : value);
    this.config.routes.conversation.asr = clear(
      this.config.routes.conversation.asr,
    );
    this.config.routes.conversation.llm = clear(
      this.config.routes.conversation.llm,
    );
    this.config.routes.conversation.tts = clear(
      this.config.routes.conversation.tts,
    );
    this.config.routes.doorEvent.llm = clear(
      this.config.routes.doorEvent.llm,
    );
    this.config.routes.doorEvent.tts = clear(
      this.config.routes.doorEvent.tts,
    );
    this.config.routes.vision = clear(this.config.routes.vision);
    this.config.routes.embedding = clear(this.config.routes.embedding);
    this.config.updatedAt = new Date().toISOString();
    await this.writeConfig();
    return true;
  }

  async updateSettings(
    patch: Partial<Pick<AppConfig, "routes" | "prompts" | "privacy">>,
  ): Promise<AppConfig> {
    if (patch.routes) {
      this.config.routes = {
        ...this.config.routes,
        ...patch.routes,
        conversation: {
          ...this.config.routes.conversation,
          ...(patch.routes.conversation ?? {}),
        },
        doorEvent: {
          ...this.config.routes.doorEvent,
          ...(patch.routes.doorEvent ?? {}),
        },
      };
    }
    if (patch.prompts) {
      this.config.prompts = {
        ...this.config.prompts,
        ...patch.prompts,
      };
    }
    if (patch.privacy) {
      this.config.privacy = {
        ...this.config.privacy,
        ...patch.privacy,
      };
    }
    this.config.updatedAt = new Date().toISOString();
    await this.writeConfig();
    return this.getConfig();
  }

  async getProviderSecret(id: string): Promise<string> {
    return this.getSecret(`provider:${id}`);
  }

  async ensureDeviceToken(): Promise<string> {
    let token = await this.getSecret("gateway:device-token");
    if (!token) {
      token = randomBytes(24).toString("hex");
      await this.setSecret("gateway:device-token", token);
      this.config.gateway.deviceTokenHint = `••••${token.slice(-4)}`;
      await this.writeConfig();
    }
    return token;
  }

  async rotateDeviceToken(): Promise<{ token: string; hint: string }> {
    const token = randomBytes(24).toString("hex");
    await this.setSecret("gateway:device-token", token);
    this.config.gateway.deviceTokenHint = `••••${token.slice(-4)}`;
    await this.writeConfig();
    return { token, hint: this.config.gateway.deviceTokenHint };
  }

  async appendAudit(
    action: string,
    outcome: AuditEntry["outcome"],
    detail: string,
  ): Promise<void> {
    if (!this.config.privacy.auditEnabled) {
      return;
    }
    const entry: AuditEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      action,
      outcome,
      detail: detail.slice(0, 500),
    };
    await writeFile(this.auditPath, `${JSON.stringify(entry)}\n`, {
      flag: "a",
      mode: 0o600,
    });
  }

  async readAudit(limit = 80): Promise<AuditEntry[]> {
    try {
      const text = await readFile(this.auditPath, "utf8");
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-Math.max(1, Math.min(500, limit)))
        .reverse()
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return [];
    }
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    try {
      const value = await readFile(this.keyPath);
      if (value.length !== 32) {
        throw new Error("invalid vault key");
      }
      await chmod(this.keyPath, 0o600);
      return value;
    } catch {
      const value = randomBytes(32);
      await writeFile(this.keyPath, value, { mode: 0o600 });
      return value;
    }
  }

  private async loadJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private async atomicJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  private async writeConfig(): Promise<void> {
    await this.atomicJson(this.configPath, this.config);
  }

  private async writeVault(): Promise<void> {
    await this.atomicJson(this.vaultPath, this.vault);
  }

  private async setSecret(name: string, value: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    this.vault.secrets[name] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      value: encrypted.toString("base64"),
    };
    await this.writeVault();
  }

  private async getSecret(name: string): Promise<string> {
    const item = this.vault.secrets[name];
    if (!item) {
      return "";
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(item.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(item.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(item.value, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private async deleteSecret(name: string): Promise<void> {
    delete this.vault.secrets[name];
    await this.writeVault();
  }
}
