import type { novaConfig } from "../config/config.js";

export function resolveWhatsAppAccount(params: { cfg: novaConfig; accountId?: string | null }) {
  const channel = params.cfg.channels?.whatsapp ?? {};
  const accountId = params.accountId?.trim() || "default";
  return {
    accountId,
    ...(channel.accounts?.[accountId] ?? channel),
  };
}
