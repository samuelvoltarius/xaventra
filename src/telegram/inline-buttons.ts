import type { novaConfig } from "../config/config.js";

export function isTelegramInlineButtonsEnabled(_params: {
  cfg: novaConfig;
  accountId?: string | null;
}): boolean {
  return true;
}
