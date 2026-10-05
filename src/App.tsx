import {
  Activity,
  AlertCircle,
  AudioLines,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Cloud,
  Cpu,
  Database,
  Eye,
  Home,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  Plus,
  Radio,
  RefreshCw,
  Route,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";

type ProviderKind = "llm" | "asr" | "tts" | "vision" | "embedding";
type ProviderDriver = "openai-compatible" | "ollama" | "custom-http";
type ProviderLocation = "local" | "cloud";
type NavId = "overview" | "providers" | "agents" | "routing" | "privacy" | "gateway";

interface Provider {
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
  updatedAt: string;
}

interface Config {
  providers: Provider[];
  routes: {
    conversation: { asr: string; llm: string; tts: string };
    doorEvent: { llm: string; tts: string };
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

interface AuditEntry {
  id: string;
  at: string;
  action: string;
  outcome: "success" | "error" | "info";
  detail: string;
}

interface GatewayStatus {
  running: boolean;
  startedAt?: string;
  connections?: Array<{
    sessionId: string;
    deviceId: string;
    clientId: string;
    connectedAt: string;
    lastSeenAt: string;
  }>;
  lastError?: string;
  lastTranscript?: string;
  lastResponse?: string;
}

interface ProviderDraft {
  id?: string;
  name: string;
  kind: ProviderKind;
  driver: ProviderDriver;
  location: ProviderLocation;
  baseUrl: string;
  model: string;
  voice: string;
  enabled: boolean;
  timeoutMs: number;
  apiKey: string;
}

const API = "http://127.0.0.1:8090";

const KIND_META: Record<
  ProviderKind,
  { label: string; short: string; icon: typeof Bot; color: string }
> = {
  llm: { label: "语言模型", short: "LLM", icon: Bot, color: "violet" },
  asr: { label: "语音识别", short: "ASR", icon: AudioLines, color: "cyan" },
  tts: { label: "语音合成", short: "TTS", icon: MessageSquareText, color: "amber" },
  vision: { label: "视觉模型", short: "Vision", icon: Eye, color: "rose" },
  embedding: { label: "向量模型", short: "Embedding", icon: Database, color: "green" },
};

const NAV_ITEMS: Array<{ id: NavId; label: string; icon: typeof Home }> = [
  { id: "overview", label: "总览", icon: Home },
  { id: "providers", label: "模型服务", icon: Boxes },
  { id: "agents", label: "角色与 Prompt", icon: Sparkles },
  { id: "routing", label: "模型路由", icon: Route },
  { id: "privacy", label: "隐私与审计", icon: ShieldCheck },
  { id: "gateway", label: "设备网关", icon: Radio },
];

const EMPTY_DRAFT: ProviderDraft = {
  name: "",
  kind: "llm",
  driver: "openai-compatible",
  location: "local",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "",
  voice: "alloy",
  enabled: true,
  timeoutMs: 20000,
  apiKey: "",
};

const PRESETS = [
  {
    label: "Ollama 本地模型",
    description: "本机 Ollama 原生 API",
    patch: {
      name: "Ollama",
      driver: "ollama" as const,
      location: "local" as const,
      baseUrl: "http://127.0.0.1:11434",
    },
  },
  {
    label: "llama.cpp",
    description: "本机 OpenAI 兼容服务",
    patch: {
      name: "llama.cpp",
      driver: "openai-compatible" as const,
      location: "local" as const,
      baseUrl: "http://127.0.0.1:8080/v1",
    },
  },
  {
    label: "云端兼容 API",
    description: "任意 OpenAI-compatible 服务",
    patch: {
      name: "云端模型",
      driver: "openai-compatible" as const,
      location: "cloud" as const,
      baseUrl: "https://api.example.com/v1",
    },
  },
];

function formatTime(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `请求失败（${response.status}）`);
  }
  return body;
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  danger = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
  danger?: boolean;
}) {
  return (
    <label className={`toggle-row ${danger ? "toggle-danger" : ""}`}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}

export default function HomePage() {
  const [active, setActive] = useState<NavId>("overview");
  const [config, setConfig] = useState<Config | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>({
    running: false,
  });
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(
    null,
  );
  const [promptSaving, setPromptSaving] = useState(false);
  const [previewIdentity, setPreviewIdentity] = useState<"dad" | "stranger" | "">("");
  const [previewText, setPreviewText] = useState("");
  const [revealedToken, setRevealedToken] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextAudit, nextGatewayStatus] = await Promise.all([
        api<Config>("/api/config"),
        api<AuditEntry[]>("/api/audit?limit=20"),
        api<GatewayStatus>("/api/gateway/status"),
      ]);
      setConfig(nextConfig);
      setAudit(nextAudit);
      setGatewayStatus(nextGatewayStatus);
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const counts = useMemo(() => {
    const providers = config?.providers ?? [];
    return {
      total: providers.length,
      local: providers.filter((item) => item.location === "local").length,
      cloud: providers.filter((item) => item.location === "cloud").length,
      ready: providers.filter((item) => item.enabled).length,
    };
  }, [config]);

  function openNewProvider(kind: ProviderKind = "llm") {
    setDraft({
      ...EMPTY_DRAFT,
      kind,
      baseUrl:
        kind === "llm"
          ? "http://127.0.0.1:11434/v1"
          : "http://127.0.0.1:8080/v1",
    });
    setModalOpen(true);
  }

  function openEditProvider(provider: Provider) {
    setDraft({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      driver: provider.driver,
      location: provider.location,
      baseUrl: provider.baseUrl,
      model: provider.model,
      voice: provider.voice || "alloy",
      enabled: provider.enabled,
      timeoutMs: provider.timeoutMs,
      apiKey: "",
    });
    setModalOpen(true);
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api<Provider>("/api/providers", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setModalOpen(false);
      setNotice({ tone: "ok", text: "模型服务已保存，密钥已写入本地加密仓库" });
      await refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存失败",
      });
    } finally {
      setSaving(false);
    }
  }

  async function deleteProvider(provider: Provider) {
    if (!window.confirm(`确定删除“${provider.name}”吗？`)) return;
    try {
      await api(`/api/providers/${encodeURIComponent(provider.id)}`, {
        method: "DELETE",
      });
      setNotice({ tone: "ok", text: "模型服务与对应密钥已删除" });
      await refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除失败",
      });
    }
  }

  async function testConnection(provider: Provider) {
    setTestingId(provider.id);
    try {
      const result = await api<{ message: string; latencyMs: number }>(
        `/api/providers/${encodeURIComponent(provider.id)}/test`,
        { method: "POST" },
      );
      setNotice({
        tone: "ok",
        text: `${result.message} · ${result.latencyMs}ms`,
      });
      await refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "连接失败",
      });
    } finally {
      setTestingId("");
    }
  }

  async function saveSettings(section: "prompts" | "routes" | "privacy") {
    if (!config) return;
    setPromptSaving(true);
    try {
      const next = await api<Config>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ [section]: config[section] }),
      });
      setConfig(next);
      setNotice({ tone: "ok", text: "设置已保存" });
      await refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存失败",
      });
    } finally {
      setPromptSaving(false);
    }
  }

  async function previewDoor(identity: "dad" | "stranger") {
    setPreviewIdentity(identity);
    setPreviewText("");
    try {
      const result = await api<{ text: string }>("/api/preview/door", {
        method: "POST",
        body: JSON.stringify({ identity }),
      });
      setPreviewText(result.text);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "生成失败",
      });
    } finally {
      setPreviewIdentity("");
    }
  }

  async function rotateToken() {
    if (!window.confirm("旧设备 Token 会立即失效，确定轮换吗？")) return;
    try {
      const result = await api<{ token: string }>("/api/gateway/token/rotate", {
        method: "POST",
      });
      setRevealedToken(result.token);
      setNotice({ tone: "ok", text: "新 Token 仅在本次页面中显示，请立即保存" });
      await refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "轮换失败",
      });
    }
  }

  if (loading) {
    return (
      <main className="boot-screen">
        <div className="boot-mark">
          <span>XP</span>
        </div>
        <p>正在连接小喷本地控制台…</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">XP</div>
          <div>
            <strong>小喷 Hub</strong>
            <span>LOCAL CONSOLE</span>
          </div>
        </div>

        <nav aria-label="控制台导航">
          <p className="nav-label">工作台</p>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={active === item.id ? "nav-item active" : "nav-item"}
                onClick={() => setActive(item.id)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.id === "providers" && counts.total > 0 ? (
                  <em>{counts.total}</em>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />
        <div className="privacy-seal">
          <LockKeyhole size={17} />
          <div>
            <strong>本地优先</strong>
            <span>密钥不会返回浏览器</span>
          </div>
        </div>
        <div className="service-state">
          <span className={online ? "state-dot online" : "state-dot"} />
          <span>{online ? "本地服务运行中" : "本地服务未连接"}</span>
          <small>v0.1.0</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="page-title">
            <p>小喷一号 · 家庭智能中枢</p>
            <h1>{NAV_ITEMS.find((item) => item.id === active)?.label}</h1>
          </div>
          <div className="top-actions">
            <div className="local-chip">
              <ShieldCheck size={15} />
              <span>LAN ONLY</span>
            </div>
            <button className="icon-button" type="button" onClick={refresh} aria-label="刷新">
              <RefreshCw size={17} />
            </button>
            <button className="primary-button" type="button" onClick={() => openNewProvider()}>
              <Plus size={17} />
              添加模型服务
            </button>
          </div>
        </header>

        <div className="content">
          {!online ? (
            <div className="offline-banner">
              <WifiOff size={18} />
              <div>
                <strong>本地服务未启动</strong>
                <span>请启动 XiaoPen Hub 服务端后刷新页面。</span>
              </div>
            </div>
          ) : null}

          {active === "overview" && config ? (
            <Overview
              config={config}
              audit={audit}
              counts={counts}
              onNavigate={setActive}
              onAdd={() => openNewProvider()}
            />
          ) : null}
          {active === "providers" && config ? (
            <Providers
              providers={config.providers}
              testingId={testingId}
              onAdd={openNewProvider}
              onEdit={openEditProvider}
              onDelete={deleteProvider}
              onTest={testConnection}
            />
          ) : null}
          {active === "agents" && config ? (
            <Agents
              config={config}
              saving={promptSaving}
              previewIdentity={previewIdentity}
              previewText={previewText}
              onChange={setConfig}
              onSave={() => saveSettings("prompts")}
              onPreview={previewDoor}
            />
          ) : null}
          {active === "routing" && config ? (
            <Routing
              config={config}
              saving={promptSaving}
              onChange={setConfig}
              onSave={() => saveSettings("routes")}
            />
          ) : null}
          {active === "privacy" && config ? (
            <Privacy
              config={config}
              audit={audit}
              saving={promptSaving}
              onChange={setConfig}
              onSave={() => saveSettings("privacy")}
            />
          ) : null}
          {active === "gateway" && config ? (
            <Gateway
              config={config}
              online={online}
              status={gatewayStatus}
              revealedToken={revealedToken}
              onRotate={rotateToken}
            />
          ) : null}
        </div>
      </section>

      {notice ? (
        <div className={`toast toast-${notice.tone}`} role="status">
          {notice.tone === "ok" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{notice.text}</span>
        </div>
      ) : null}

      {modalOpen ? (
        <ProviderModal
          draft={draft}
          saving={saving}
          existingHint={
            draft.id
              ? config?.providers.find((item) => item.id === draft.id)?.apiKeyHint ?? ""
              : ""
          }
          onChange={setDraft}
          onClose={() => setModalOpen(false)}
          onSubmit={saveProvider}
        />
      ) : null}
    </main>
  );
}

function Overview({
  config,
  audit,
  counts,
  onNavigate,
  onAdd,
}: {
  config: Config;
  audit: AuditEntry[];
  counts: { total: number; local: number; cloud: number; ready: number };
  onNavigate: (id: NavId) => void;
  onAdd: () => void;
}) {
  const routeReady = Boolean(
    config.routes.conversation.asr &&
      config.routes.conversation.llm &&
      config.routes.conversation.tts,
  );
  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div className="hero-copy">
          <Badge tone="green">
            <span className="pulse-dot" />
            LOCAL-FIRST CONTROL PLANE
          </Badge>
          <h2>
            模型在你手里，
            <br />
            数据边界由你决定。
          </h2>
          <p>
            一个轻量的本地控制台，统一管理小喷的模型、Prompt、隐私策略和设备连接。
            云端 API 与本地模型可以自由组合。
          </p>
          <div className="hero-actions">
            <button className="primary-button large" type="button" onClick={onAdd}>
              <Plus size={18} />
              接入第一个模型
            </button>
            <button className="text-button" type="button" onClick={() => onNavigate("routing")}>
              查看模型路由
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        <div className="signal-orbit" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="core-node">
            <span>XP</span>
            <small>LOCAL</small>
          </div>
          <div className="satellite satellite-one">ASR</div>
          <div className="satellite satellite-two">LLM</div>
          <div className="satellite satellite-three">TTS</div>
        </div>
      </section>

      <section className="metrics-grid">
        <Metric
          label="模型服务"
          value={String(counts.total)}
          detail={`${counts.local} 本地 · ${counts.cloud} 云端`}
          icon={<Boxes size={20} />}
        />
        <Metric
          label="对话链路"
          value={routeReady ? "已配置" : "待配置"}
          detail={routeReady ? "ASR → LLM → TTS" : "还缺少默认路由"}
          icon={<Route size={20} />}
          tone={routeReady ? "green" : "amber"}
        />
        <Metric
          label="云端音频"
          value={config.privacy.allowCloudAudio ? "允许" : "已阻止"}
          detail="默认策略"
          icon={<ShieldCheck size={20} />}
          tone={config.privacy.allowCloudAudio ? "amber" : "green"}
        />
        <Metric
          label="设备网关"
          value="待接入"
          detail={`端口 ${config.gateway.devicePort}`}
          icon={<Radio size={20} />}
        />
      </section>

      <section className="two-column">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ROUTING</p>
              <h3>当前处理链路</h3>
            </div>
            <button className="text-button" type="button" onClick={() => onNavigate("routing")}>
              编辑
            </button>
          </div>
          <Pipeline config={config} />
        </div>
        <div className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">AUDIT</p>
              <h3>最近活动</h3>
            </div>
            <button className="text-button" type="button" onClick={() => onNavigate("privacy")}>
              查看全部
            </button>
          </div>
          <AuditList entries={audit.slice(0, 5)} />
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone?: "neutral" | "green" | "amber";
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function Pipeline({ config }: { config: Config }) {
  const find = (id: string) => config.providers.find((item) => item.id === id);
  const steps: Array<{ kind: ProviderKind; provider?: Provider }> = [
    { kind: "asr", provider: find(config.routes.conversation.asr) },
    { kind: "llm", provider: find(config.routes.conversation.llm) },
    { kind: "tts", provider: find(config.routes.conversation.tts) },
  ];
  return (
    <div className="pipeline">
      {steps.map((step, index) => {
        const Icon = KIND_META[step.kind].icon;
        return (
          <div className="pipeline-group" key={step.kind}>
            <div className={step.provider ? "pipeline-node ready" : "pipeline-node"}>
              <Icon size={19} />
              <span>
                <small>{KIND_META[step.kind].short}</small>
                <strong>{step.provider?.name ?? "未选择"}</strong>
              </span>
              {step.provider?.location === "cloud" ? <Cloud size={14} /> : <Cpu size={14} />}
            </div>
            {index < steps.length - 1 ? <ChevronRight className="pipeline-arrow" size={17} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function Providers({
  providers,
  testingId,
  onAdd,
  onEdit,
  onDelete,
  onTest,
}: {
  providers: Provider[];
  testingId: string;
  onAdd: (kind?: ProviderKind) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onTest: (provider: Provider) => void;
}) {
  const [filter, setFilter] = useState<ProviderKind | "all">("all");
  const filtered = providers.filter((item) => filter === "all" || item.kind === filter);
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <p className="eyebrow">MODEL PROVIDERS</p>
          <h2>把本地模型和云端 API 放在同一张桌子上。</h2>
          <p>
            API Key 由本机服务端加密保存；控制台只展示末四位，保存后不会再次返回完整内容。
          </p>
        </div>
        <button className="primary-button large" type="button" onClick={() => onAdd()}>
          <Plus size={18} />
          新建 Provider
        </button>
      </section>

      <div className="filter-bar" role="tablist" aria-label="模型类型筛选">
        <button
          type="button"
          className={filter === "all" ? "active" : ""}
          onClick={() => setFilter("all")}
        >
          全部 <span>{providers.length}</span>
        </button>
        {(Object.keys(KIND_META) as ProviderKind[]).map((kind) => (
          <button
            type="button"
            key={kind}
            className={filter === kind ? "active" : ""}
            onClick={() => setFilter(kind)}
          >
            {KIND_META[kind].short}
            <span>{providers.filter((item) => item.kind === kind).length}</span>
          </button>
        ))}
      </div>

      {filtered.length ? (
        <section className="provider-grid">
          {filtered.map((provider) => {
            const meta = KIND_META[provider.kind];
            const Icon = meta.icon;
            return (
              <article className="provider-card" key={provider.id}>
                <div className="provider-top">
                  <div className={`provider-icon icon-${meta.color}`}>
                    <Icon size={21} />
                  </div>
                  <div className="provider-title">
                    <h3>{provider.name}</h3>
                    <span>{meta.label}</span>
                  </div>
                  <span className={provider.enabled ? "provider-status enabled" : "provider-status"}>
                    {provider.enabled ? "启用" : "停用"}
                  </span>
                </div>
                <div className="provider-model">
                  <span>MODEL</span>
                  <strong>{provider.model || "由服务端自动选择"}</strong>
                </div>
                <dl className="provider-details">
                  <div>
                    <dt>运行位置</dt>
                    <dd>
                      {provider.location === "local" ? <Cpu size={14} /> : <Cloud size={14} />}
                      {provider.location === "local" ? "本地" : "云端"}
                    </dd>
                  </div>
                  <div>
                    <dt>密钥</dt>
                    <dd>
                      <KeyRound size={14} />
                      {provider.apiKeyStored ? provider.apiKeyHint : "无需密钥"}
                    </dd>
                  </div>
                </dl>
                <div className="endpoint-line" title={provider.baseUrl}>
                  {provider.baseUrl}
                </div>
                <div className="provider-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={testingId === provider.id}
                    onClick={() => onTest(provider)}
                  >
                    {testingId === provider.id ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Activity size={15} />
                    )}
                    测试连接
                  </button>
                  <button type="button" className="secondary-button" onClick={() => onEdit(provider)}>
                    配置
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => onDelete(provider)}
                    aria-label={`删除 ${provider.name}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="empty-state">
          <div className="empty-graphic">
            <Boxes size={30} />
          </div>
          <h3>{providers.length ? "这个分类还没有模型" : "还没有接入模型服务"}</h3>
          <p>可以连接 Ollama、llama.cpp、云端 OpenAI-compatible API 或自定义服务。</p>
          <div className="quick-kind-grid">
            {(Object.keys(KIND_META) as ProviderKind[]).slice(0, 3).map((kind) => {
              const Icon = KIND_META[kind].icon;
              return (
                <button key={kind} type="button" onClick={() => onAdd(kind)}>
                  <Icon size={18} />
                  添加 {KIND_META[kind].short}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Agents({
  config,
  saving,
  previewIdentity,
  previewText,
  onChange,
  onSave,
  onPreview,
}: {
  config: Config;
  saving: boolean;
  previewIdentity: string;
  previewText: string;
  onChange: (config: Config) => void;
  onSave: () => void;
  onPreview: (identity: "dad" | "stranger") => void;
}) {
  const setPrompt = (key: keyof Config["prompts"], value: string) =>
    onChange({ ...config, prompts: { ...config.prompts, [key]: value } });
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <p className="eyebrow">PERSONA & PROMPTS</p>
          <h2>让小喷说什么，由你定义。</h2>
          <p>角色 Prompt 和门口事件模板只保存在这台 Mac；你可以随时测试生成效果。</p>
        </div>
        <button className="primary-button large" type="button" onClick={onSave} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}
          保存全部 Prompt
        </button>
      </section>
      <section className="prompt-layout">
        <div className="panel prompt-panel">
          <div className="panel-heading">
            <div>
              <Badge tone="blue">SYSTEM</Badge>
              <h3>小喷一号角色设定</h3>
            </div>
            <span className="char-count">{config.prompts.assistant.length} 字</span>
          </div>
          <textarea
            value={config.prompts.assistant}
            onChange={(event) => setPrompt("assistant", event.target.value)}
            rows={8}
            aria-label="小喷一号角色设定"
          />
          <p className="field-hint">会作为每次对话和主动事件的系统指令。</p>
        </div>
        <div className="panel event-prompts">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">DOOR EVENTS</p>
              <h3>门口事件台词</h3>
            </div>
          </div>
          <label>
            <span>
              <strong>爸爸回家</strong>
              <Badge tone="green">dad</Badge>
            </span>
            <textarea
              value={config.prompts.doorDad}
              onChange={(event) => setPrompt("doorDad", event.target.value)}
              rows={4}
            />
          </label>
          <label>
            <span>
              <strong>发现陌生人</strong>
              <Badge tone="red">stranger</Badge>
            </span>
            <textarea
              value={config.prompts.doorStranger}
              onChange={(event) => setPrompt("doorStranger", event.target.value)}
              rows={4}
            />
          </label>
          <div className="preview-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={Boolean(previewIdentity)}
              onClick={() => onPreview("dad")}
            >
              {previewIdentity === "dad" ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              测试爸爸台词
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={Boolean(previewIdentity)}
              onClick={() => onPreview("stranger")}
            >
              {previewIdentity === "stranger" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
              测试警戒台词
            </button>
          </div>
          {previewText ? (
            <blockquote>
              <Sparkles size={17} />
              <span>{previewText}</span>
            </blockquote>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Routing({
  config,
  saving,
  onChange,
  onSave,
}: {
  config: Config;
  saving: boolean;
  onChange: (config: Config) => void;
  onSave: () => void;
}) {
  const providersFor = (kind: ProviderKind) =>
    config.providers.filter((provider) => provider.kind === kind && provider.enabled);
  const select = (
    label: string,
    kind: ProviderKind,
    value: string,
    setValue: (value: string) => void,
  ) => (
    <label className="route-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="">未选择</option>
        {providersFor(kind).map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name} · {provider.location === "local" ? "本地" : "云端"}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <p className="eyebrow">MODEL ROUTING</p>
          <h2>不同任务，走不同的模型链路。</h2>
          <p>普通对话可以使用强模型，门口一句话可以交给更快、更私密的本地模型。</p>
        </div>
        <button className="primary-button large" type="button" onClick={onSave} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}
          保存路由
        </button>
      </section>
      <section className="routing-grid">
        <article className="route-card">
          <div className="route-card-header">
            <div className="route-number">01</div>
            <div>
              <Badge tone="blue">VOICE</Badge>
              <h3>普通语音对话</h3>
              <p>小喷唤醒后的默认处理链路</p>
            </div>
          </div>
          <div className="route-form">
            {select("语音识别 ASR", "asr", config.routes.conversation.asr, (value) =>
              onChange({
                ...config,
                routes: {
                  ...config.routes,
                  conversation: { ...config.routes.conversation, asr: value },
                },
              }),
            )}
            {select("语言模型 LLM", "llm", config.routes.conversation.llm, (value) =>
              onChange({
                ...config,
                routes: {
                  ...config.routes,
                  conversation: { ...config.routes.conversation, llm: value },
                },
              }),
            )}
            {select("语音合成 TTS", "tts", config.routes.conversation.tts, (value) =>
              onChange({
                ...config,
                routes: {
                  ...config.routes,
                  conversation: { ...config.routes.conversation, tts: value },
                },
              }),
            )}
          </div>
        </article>
        <article className="route-card accent">
          <div className="route-card-header">
            <div className="route-number">02</div>
            <div>
              <Badge tone="green">AUTOMATION</Badge>
              <h3>门口主动事件</h3>
              <p>爸爸或陌生人出现时的快速链路</p>
            </div>
          </div>
          <div className="route-form">
            {select("语言模型 LLM", "llm", config.routes.doorEvent.llm, (value) =>
              onChange({
                ...config,
                routes: {
                  ...config.routes,
                  doorEvent: { ...config.routes.doorEvent, llm: value },
                },
              }),
            )}
            {select("语音合成 TTS", "tts", config.routes.doorEvent.tts, (value) =>
              onChange({
                ...config,
                routes: {
                  ...config.routes,
                  doorEvent: { ...config.routes.doorEvent, tts: value },
                },
              }),
            )}
            {select("视觉识别 Vision", "vision", config.routes.vision, (value) =>
              onChange({
                ...config,
                routes: { ...config.routes, vision: value },
              }),
            )}
          </div>
        </article>
      </section>
      <div className="route-note">
        <CircleGauge size={20} />
        <div>
          <strong>路由只决定数据去向</strong>
          <span>是否允许音频、图片或文字离开本机，仍由“隐私与审计”中的全局策略控制。</span>
        </div>
      </div>
    </div>
  );
}

function Privacy({
  config,
  audit,
  saving,
  onChange,
  onSave,
}: {
  config: Config;
  audit: AuditEntry[];
  saving: boolean;
  onChange: (config: Config) => void;
  onSave: () => void;
}) {
  const set = (key: keyof Config["privacy"], value: boolean) =>
    onChange({ ...config, privacy: { ...config.privacy, [key]: value } });
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <p className="eyebrow">PRIVACY BOUNDARY</p>
          <h2>默认不外发，例外必须由你打开。</h2>
          <p>这些规则独立于模型路由。即使选中了云端 Provider，禁止的数据仍不会发送。</p>
        </div>
        <button className="primary-button large" type="button" onClick={onSave} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}
          保存隐私策略
        </button>
      </section>
      <section className="privacy-layout">
        <div className="panel privacy-controls">
          <div className="panel-heading">
            <div>
              <Badge tone="green">DEFAULT DENY</Badge>
              <h3>数据出站策略</h3>
            </div>
            <ShieldCheck size={25} />
          </div>
          <Toggle
            checked={config.privacy.allowCloudAudio}
            onChange={(value) => set("allowCloudAudio", value)}
            label="允许原始音频发送到云端"
            description="关闭后，语音必须先在本机完成 ASR。"
            danger
          />
          <Toggle
            checked={config.privacy.allowCloudImages}
            onChange={(value) => set("allowCloudImages", value)}
            label="允许摄像头图片发送到云端"
            description="建议永久关闭；人脸检测和识别在 Mac 本地完成。"
            danger
          />
          <Toggle
            checked={config.privacy.allowCloudTranscripts}
            onChange={(value) => set("allowCloudTranscripts", value)}
            label="允许文字转写发送到云端 LLM"
            description="平衡模式只发送文字，不发送原始语音。"
          />
          <Toggle
            checked={config.privacy.retainTranscripts}
            onChange={(value) => set("retainTranscripts", value)}
            label="保留完整对话文本"
            description="关闭后仅保留不含内容的运行指标。"
          />
          <Toggle
            checked={config.privacy.auditEnabled}
            onChange={(value) => set("auditEnabled", value)}
            label="记录本地审计事件"
            description="记录配置修改和请求结果，不记录 API Key。"
          />
        </div>
        <div className="panel audit-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">LOCAL AUDIT</p>
              <h3>最近审计事件</h3>
            </div>
            <Badge tone="blue">{audit.length} 条</Badge>
          </div>
          <AuditList entries={audit} />
        </div>
      </section>
    </div>
  );
}

function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) {
    return (
      <div className="audit-empty">
        <Activity size={20} />
        <span>还没有审计事件</span>
      </div>
    );
  }
  return (
    <div className="audit-list">
      {entries.map((entry) => (
        <div className="audit-row" key={entry.id}>
          <span className={`audit-dot audit-${entry.outcome}`}>
            {entry.outcome === "success" ? <Check size={12} /> : <AlertCircle size={12} />}
          </span>
          <div>
            <strong>{entry.detail || entry.action}</strong>
            <small>{entry.action}</small>
          </div>
          <time>{formatTime(entry.at)}</time>
        </div>
      ))}
    </div>
  );
}

function Gateway({
  config,
  online,
  status,
  revealedToken,
  onRotate,
}: {
  config: Config;
  online: boolean;
  status: GatewayStatus;
  revealedToken: string;
  onRotate: () => void;
}) {
  const connections = status.connections ?? [];
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <p className="eyebrow">DEVICE GATEWAY</p>
          <h2>让小喷只连接这台 Mac。</h2>
          <p>设备网关使用 XiaoPen Device Protocol v1，并用独立 Token 鉴权。</p>
        </div>
      </section>
      <section className="gateway-grid">
        <div className="panel gateway-status-panel">
          <div className="gateway-live">
            <span className={online ? "gateway-ring online" : "gateway-ring"}>
              {online ? <Wifi size={26} /> : <WifiOff size={26} />}
            </span>
            <div>
              <Badge tone={online ? "green" : "red"}>{online ? "ADMIN ONLINE" : "OFFLINE"}</Badge>
              <h3>本地管理服务</h3>
              <p>仅监听 Mac 回环地址，不向局域网暴露控制台 API。</p>
            </div>
          </div>
          <dl className="gateway-facts">
            <div>
              <dt>管理 API</dt>
              <dd>127.0.0.1:{config.gateway.adminPort}</dd>
            </div>
            <div>
              <dt>设备网关</dt>
              <dd>
                {status.running ? "运行中" : "未启动"} · 局域网:{config.gateway.devicePort}
              </dd>
            </div>
            <div>
              <dt>鉴权 Token</dt>
              <dd>{config.gateway.deviceTokenHint || "未生成"}</dd>
            </div>
            <div>
              <dt>已连接设备</dt>
              <dd>{connections.length} 台</dd>
            </div>
          </dl>
          {connections.length ? (
            <div className="gateway-device-list">
              {connections.map((connection) => (
                <div key={connection.sessionId}>
                  <span className="state-dot online" />
                  <strong>{connection.deviceId}</strong>
                  <small>最后活动 {formatTime(connection.lastSeenAt)}</small>
                </div>
              ))}
            </div>
          ) : null}
          {status.lastError ? (
            <div className="inline-warning">
              <AlertCircle size={16} />
              <span>{status.lastError}</span>
            </div>
          ) : null}
        </div>
        <div className="panel token-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">DEVICE CREDENTIAL</p>
              <h3>设备访问凭据</h3>
            </div>
            <KeyRound size={23} />
          </div>
          <p>Token 使用 AES-256-GCM 保存在本机密钥仓库。轮换后旧 Token 会立即失效。</p>
          {revealedToken ? (
            <div className="token-reveal">
              <span>新 Token · 仅显示一次</span>
              <code>{revealedToken}</code>
            </div>
          ) : (
            <div className="token-mask">{config.gateway.deviceTokenHint || "••••••••"}</div>
          )}
          <button type="button" className="secondary-button" onClick={onRotate}>
            <RefreshCw size={15} />
            轮换设备 Token
          </button>
        </div>
      </section>
      <div className="gateway-roadmap">
        <div className="roadmap-step done">
          <span>1</span>
          <div>
            <strong>本地控制面</strong>
            <small>配置、密钥、Prompt 与审计</small>
          </div>
        </div>
        <ChevronRight size={18} />
        <div className="roadmap-step done">
          <span>2</span>
          <div>
            <strong>XiaoPen Protocol</strong>
            <small>设备握手与 Opus 会话</small>
          </div>
        </div>
        <ChevronRight size={18} />
        <div className="roadmap-step current">
          <span>3</span>
          <div>
            <strong>小喷一号在线</strong>
            <small>本地 OTA 发现与语音会话</small>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProviderModal({
  draft,
  saving,
  existingHint,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: ProviderDraft;
  saving: boolean;
  existingHint: string;
  onChange: (draft: ProviderDraft) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">{draft.id ? "EDIT PROVIDER" : "NEW PROVIDER"}</p>
            <h2 id="provider-title">{draft.id ? "配置模型服务" : "接入模型服务"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={19} />
          </button>
        </div>
        {!draft.id ? (
          <div className="preset-row">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => onChange({ ...draft, ...preset.patch })}
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <label>
              <span>显示名称</span>
              <input
                required
                value={draft.name}
                onChange={(event) => onChange({ ...draft, name: event.target.value })}
                placeholder="例如：客厅 Ollama"
              />
            </label>
            <label>
              <span>能力类型</span>
              <select
                value={draft.kind}
                onChange={(event) =>
                  onChange({ ...draft, kind: event.target.value as ProviderKind })
                }
              >
                {(Object.keys(KIND_META) as ProviderKind[]).map((kind) => (
                  <option value={kind} key={kind}>
                    {KIND_META[kind].label} · {KIND_META[kind].short}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>接口驱动</span>
              <select
                value={draft.driver}
                onChange={(event) =>
                  onChange({ ...draft, driver: event.target.value as ProviderDriver })
                }
              >
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="ollama">Ollama 原生 API</option>
                <option value="custom-http">自定义 HTTP</option>
              </select>
            </label>
            <label>
              <span>运行位置</span>
              <select
                value={draft.location}
                onChange={(event) =>
                  onChange({ ...draft, location: event.target.value as ProviderLocation })
                }
              >
                <option value="local">本地 · 数据不离开 Mac</option>
                <option value="cloud">云端 · 受隐私策略约束</option>
              </select>
            </label>
            <label className="full">
              <span>Base URL</span>
              <input
                required
                type="url"
                value={draft.baseUrl}
                onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
                placeholder="http://127.0.0.1:11434/v1"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label className="full">
              <span>模型名称</span>
              <input
                value={draft.model}
                onChange={(event) => onChange({ ...draft, model: event.target.value })}
                placeholder="例如：本地模型名称或云端 model id"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            {draft.kind === "tts" ? (
              <label className="full">
                <span>声音 / Voice</span>
                <input
                  value={draft.voice}
                  onChange={(event) => onChange({ ...draft, voice: event.target.value })}
                  placeholder="例如：alloy、zh-CN-XiaoxiaoNeural"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
            ) : null}
            <label className="full secret-field">
              <span>
                API Key
                {existingHint ? <small>已保存 {existingHint}，留空表示不更换</small> : null}
              </span>
              <div>
                <KeyRound size={17} />
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
                  placeholder={existingHint ? "输入新 Key 以替换" : "本地服务可留空"}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </div>
              <small className="security-note">
                <LockKeyhole size={13} />
                密钥经本机服务加密保存，保存后不会返回浏览器。
              </small>
            </label>
            <label>
              <span>请求超时</span>
              <div className="suffix-input">
                <input
                  type="number"
                  min={1000}
                  max={120000}
                  step={1000}
                  value={draft.timeoutMs}
                  onChange={(event) =>
                    onChange({ ...draft, timeoutMs: Number(event.target.value) })
                  }
                />
                <span>ms</span>
              </div>
            </label>
            <label className="enabled-field">
              <span>立即启用</span>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
              />
              <span className="toggle-track">
                <span />
              </span>
            </label>
          </div>
          <div className="modal-footer">
            <button type="button" className="secondary-button" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              {draft.id ? "保存修改" : "保存 Provider"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
