import type { novaConfig } from "../../config/config.js";

export async function handleDiscordAction(
  action: Record<string, unknown>,
  _cfg: novaConfig,
): Promise<Record<string, unknown>> {
  return { ok: true, action };
}
