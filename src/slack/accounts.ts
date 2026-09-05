import type { novaConfig } from "../config/config.js";

export function resolveSlackAccount(params: { cfg: novaConfig; accountId?: string | null }) {
  const channel = params.cfg.channels?.slack ?? {};
  const accountId = params.accountId?.trim() || "default";
  const config = channel.accounts?.[accountId] ?? channel;
  return {
    accountId,
    config,
    dm: config.dm ?? channel.dm ?? {},
  };
}
