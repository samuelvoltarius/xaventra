import type { novaConfig } from "../config/config.js";

export function resolveDiscordAccount(params: { cfg: novaConfig; accountId?: string | null }) {
  const channel = params.cfg.channels?.discord ?? {};
  const accountId = params.accountId?.trim() || "default";
  const config = channel.accounts?.[accountId] ?? channel;
  return { accountId, config };
}

export function listEnabledDiscordAccounts(cfg: novaConfig) {
  const channel = cfg.channels?.discord;
  if (!channel?.token && !channel?.accounts) return [];
  const accounts = channel.accounts && typeof channel.accounts === "object"
    ? Object.entries(channel.accounts).map(([accountId, config]) => ({
        accountId,
        config,
        tokenSource: (config as any)?.token || channel.token ? "config" : "none",
      }))
    : [{ accountId: "default", config: channel, tokenSource: channel.token ? "config" : "none" }];
  return accounts;
}
