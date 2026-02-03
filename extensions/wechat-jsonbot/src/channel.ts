import type {
  ChannelAccountSnapshot,
  ChannelOnboardingAdapter,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";

export type WechatJsonBotAccountConfig = {
  enabled?: boolean;
  name?: string;
  jsonBotBaseUrl?: string;
  inboundToken?: string;
};

export type ResolvedWechatJsonBotAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: WechatJsonBotAccountConfig;
};

function normalizeWechatTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^(wechat|wx):/i, "")
    .trim();
}

function resolveWechatConfig(cfg: OpenClawConfig): WechatJsonBotAccountConfig {
  const raw = (cfg.channels as Record<string, unknown> | undefined)?.["wechat"] as
    | WechatJsonBotAccountConfig
    | undefined;
  return raw ?? {};
}

function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/[\\/]+$/, "");
}

async function postJson(params: {
  url: string;
  payload: unknown;
  timeoutMs: number;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs));
  try {
    const resp = await fetch(params.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params.payload),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, error: text || resp.statusText };
    }
    return { ok: true, status: resp.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

function applyWechatConfig(params: {
  cfg: OpenClawConfig;
  patch: Partial<WechatJsonBotAccountConfig>;
}): OpenClawConfig {
  const channels = (params.cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels["wechat"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...params.cfg,
    channels: {
      ...channels,
      wechat: {
        ...current,
        ...params.patch,
        enabled: true,
      },
    },
  } as OpenClawConfig;
}

export function resolveWechatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWechatJsonBotAccount {
  const accountId = (params.accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
  const config = resolveWechatConfig(params.cfg);
  const enabled = typeof config.enabled === "boolean" ? config.enabled : true;
  return {
    accountId,
    enabled,
    name: config.name,
    config,
  };
}

export const wechatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "wechat",
  getStatus: async ({ cfg }) => {
    const account = resolveWechatAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
    const baseUrl = String(account.config.jsonBotBaseUrl ?? "").trim();
    const configured = Boolean(baseUrl);
    return {
      channel: "wechat",
      configured,
      statusLines: [
        `WeChat: ${configured ? "configured" : "needs json_bot base URL"}`,
        configured ? `Base URL: ${baseUrl}` : "Set the json_bot base URL to enable replies.",
      ],
      selectionHint: configured ? "configured" : "needs json_bot URL",
      quickstartScore: configured ? 80 : 40,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const current = resolveWechatAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
    const nextBaseUrl = await prompter.text({
      message: "json_bot base URL",
      placeholder: "http://127.0.0.1:8788",
      initialValue: current.config.jsonBotBaseUrl,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const nextInboundToken = await prompter.text({
      message: "Inbound token (optional)",
      placeholder: "leave blank to disable auth",
      initialValue: current.config.inboundToken,
    });
    const baseUrl = normalizeBaseUrl(String(nextBaseUrl));
    const inboundToken = String(nextInboundToken ?? "").trim() || undefined;
    const next = applyWechatConfig({
      cfg,
      patch: { jsonBotBaseUrl: baseUrl, inboundToken },
    });
    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  disable: (cfg) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const current = (channels["wechat"] as Record<string, unknown> | undefined) ?? {};
    return {
      ...cfg,
      channels: {
        ...channels,
        wechat: {
          ...current,
          enabled: false,
        },
      },
    } as OpenClawConfig;
  },
};

export const wechatPlugin: ChannelPlugin<ResolvedWechatJsonBotAccount> = {
  id: "wechat",
  meta: {
    id: "wechat",
    label: "WeChat",
    selectionLabel: "WeChat (json_bot)",
    detailLabel: "WeChat",
    docsPath: "/channels/wechat",
    blurb: "WeChat via json_bot webhook + /reply gateway.",
    aliases: ["wx"],
  },
  messaging: {
    normalizeTarget: (raw) => normalizeWechatTarget(raw),
    targetResolver: {
      looksLikeId: (raw) => Boolean(normalizeWechatTarget(raw)),
      hint: 'Use the WeChat chat/session name (example: "wechat:Alice" or "Alice").',
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  onboarding: wechatOnboardingAdapter,
  reload: { configPrefixes: ["channels.wechat"] },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 2000,
    sendText: async ({ cfg, to, text }) => {
      const account = resolveWechatAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
      const baseUrl = normalizeBaseUrl(account.config.jsonBotBaseUrl);
      if (!baseUrl) {
        throw new Error("wechat: missing channels.wechat.jsonBotBaseUrl");
      }
      const sessionName = normalizeWechatTarget(to);
      const result = await postJson({
        url: `${baseUrl}/reply`,
        payload: {
          session_name: sessionName,
          content: text,
          type: "text",
        },
        timeoutMs: 5000,
      });
      if (!result.ok) {
        throw new Error(
          `wechat: json_bot /reply failed status=${String(result.status ?? "")} err=${String(result.error ?? "")}`,
        );
      }
      return {
        channel: "wechat",
        messageId: `wechat:${Date.now()}`,
        chatId: sessionName,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl }) => {
      const account = resolveWechatAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
      const baseUrl = normalizeBaseUrl(account.config.jsonBotBaseUrl);
      if (!baseUrl) {
        throw new Error("wechat: missing channels.wechat.jsonBotBaseUrl");
      }
      const sessionName = normalizeWechatTarget(to);
      const caption = String(text ?? "").trim();
      if (caption) {
        const captionResult = await postJson({
          url: `${baseUrl}/reply`,
          payload: {
            session_name: sessionName,
            content: caption,
            type: "text",
          },
          timeoutMs: 5000,
        });
        if (!captionResult.ok) {
          throw new Error(
            `wechat: json_bot /reply caption failed status=${String(captionResult.status ?? "")} err=${String(captionResult.error ?? "")}`,
          );
        }
      }
      const fileResult = await postJson({
        url: `${baseUrl}/reply`,
        payload: {
          session_name: sessionName,
          content: String(mediaUrl),
          type: "file",
        },
        timeoutMs: 15000,
      });
      if (!fileResult.ok) {
        throw new Error(
          `wechat: json_bot /reply file failed status=${String(fileResult.status ?? "")} err=${String(fileResult.error ?? "")}`,
        );
      }
      return {
        channel: "wechat",
        messageId: `wechat:${Date.now()}`,
        chatId: sessionName,
      };
    },
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveWechatAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account.config.jsonBotBaseUrl?.trim()),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.config.jsonBotBaseUrl?.trim()),
    }),
  },
};
