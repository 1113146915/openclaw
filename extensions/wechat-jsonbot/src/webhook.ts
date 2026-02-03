import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { resolveWechatAccount } from "./channel.js";
import { getWechatRuntime } from "./runtime.js";

type MoltbotInboundPayload = {
  message?: string;
  sender?: string;
  timestamp?: number;
  type?: string;
};

function parseBearerToken(headerValue: string | string[] | undefined): string | null {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("bearer ")) {
    return null;
  }
  const token = trimmed.slice("bearer ".length).trim();
  return token || null;
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      throw new Error("payload too large");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function respondJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) {
    return;
  }
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function normalizeBaseUrl(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return null;
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

async function handleInbound(params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  sender: string;
  text: string;
  timestampMs?: number;
}): Promise<void> {
  const { runtime, cfg } = params;
  const logger = runtime.logging.getChildLogger({ plugin: "wechat-jsonbot" });
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "wechat",
    accountId: DEFAULT_ACCOUNT_ID,
    peer: { kind: "dm", id: params.sender },
  });

  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "WeChat",
    from: params.sender,
    timestamp: params.timestampMs,
    previousTimestamp,
    envelope: envelopeOptions,
    body: params.text,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: params.text,
    CommandBody: params.text,
    From: `wechat:${params.sender}`,
    To: `wechat:${params.sender}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: params.sender,
    SenderName: params.sender,
    SenderId: params.sender,
    Provider: "wechat",
    Surface: "wechat-jsonbot",
    OriginatingChannel: "wechat",
    OriginatingTo: `wechat:${params.sender}`,
  });

  void runtime.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      logger.error(`wechat: failed updating session meta: ${String(err)}`);
    });

  const account = resolveWechatAccount({ cfg, accountId: route.accountId });
  const jsonBotBaseUrl = normalizeBaseUrl(account.config.jsonBotBaseUrl);
  if (!jsonBotBaseUrl) {
    logger.error("wechat: missing channels.wechat.jsonBotBaseUrl");
    return;
  }

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = (payload.text ?? "").trim();
        const mediaUrlsRaw = Array.isArray(payload.mediaUrls)
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];
        const mediaUrls = mediaUrlsRaw
          .map((url) => String(url).trim())
          .filter((url) => Boolean(url));

        if (text) {
          const result = await postJson({
            url: `${jsonBotBaseUrl}/reply`,
            payload: {
              session_name: params.sender,
              content: text,
              type: "text",
            },
            timeoutMs: 5000,
          });
          if (!result.ok) {
            logger.error(
              `wechat: json_bot /reply failed status=${String(result.status ?? "")} err=${String(result.error ?? "")}`,
            );
          }
        }

        for (const mediaUrl of mediaUrls) {
          const result = await postJson({
            url: `${jsonBotBaseUrl}/reply`,
            payload: {
              session_name: params.sender,
              content: String(mediaUrl),
              type: "file",
            },
            timeoutMs: 15000,
          });
          if (!result.ok) {
            logger.error(
              `wechat: json_bot /reply file failed status=${String(result.status ?? "")} err=${String(result.error ?? "")}`,
            );
          }
        }
      },
      onError: (err, info) => {
        logger.error(`wechat: ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

function shouldHandlePath(url: string | undefined): boolean {
  const value = (url ?? "").trim();
  if (!value) {
    return false;
  }
  const pathname = value.split("?")[0] ?? "";
  return pathname === "/webhook/wechat";
}

export async function handleWechatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if ((req.method ?? "").toUpperCase() !== "POST") {
    return false;
  }
  if (!shouldHandlePath(req.url)) {
    return false;
  }

  const runtime = getWechatRuntime();
  const logger = runtime.logging.getChildLogger({ plugin: "wechat-jsonbot" });
  const cfg = runtime.config.loadConfig();
  const account = resolveWechatAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
  const expectedToken = (account.config.inboundToken ?? "").trim();
  if (expectedToken) {
    const token =
      parseBearerToken(req.headers.authorization) ??
      (Array.isArray(req.headers["x-openclaw-token"])
        ? req.headers["x-openclaw-token"][0]
        : req.headers["x-openclaw-token"]) ??
      null;
    if (!token || String(token).trim() !== expectedToken) {
      respondJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }
  }

  let parsed: unknown;
  try {
    parsed = await readJsonBody(req, 256 * 1024);
  } catch (err) {
    respondJson(res, 400, { ok: false, error: String(err) });
    return true;
  }

  const payload = parsed as MoltbotInboundPayload;
  const sender = String(payload.sender ?? "").trim();
  const text = String(payload.message ?? "").trim();
  if (!sender || !text) {
    respondJson(res, 400, { ok: false, error: "missing sender or message" });
    return true;
  }

  respondJson(res, 202, { ok: true });

  const timestampMs =
    typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)
      ? Math.round(payload.timestamp * 1000)
      : undefined;
  void handleInbound({ runtime, cfg, sender, text, timestampMs }).catch((err) => {
    logger.error(`wechat: inbound processing failed: ${String(err)}`);
  });

  return true;
}
