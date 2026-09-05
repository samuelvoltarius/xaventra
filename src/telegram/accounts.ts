import type { novaConfig } from "../config/config.js";

export function resolveTelegramAccount(params: { cfg: novaConfig; accountId?: string | null }) {
  const channel = params.cfg.channels?.telegram ?? {};
  const accountId = params.accountId?.trim() || "default";
  const config = channel.accounts?.[accountId] ?? channel;
  return { accountId, config };
}

export function listEnabledTelegramAccounts(cfg: novaConfig) {
  const channel = cfg.channels?.telegram;
  if (!channel?.botToken && !channel?.accounts) return [];
  return channel.accounts && typeof channel.accounts === "object"
    ? Object.entries(channel.accounts).map(([accountId, config]) => ({
        accountId,
        config,
        tokenSource: (config as any)?.botToken || channel.botToken ? "config" : "none",
      }))
    : [{ accountId: "default", config: channel, tokenSource: channel.botToken ? "config" : "none" }];
}
