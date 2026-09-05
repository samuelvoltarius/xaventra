export type SlackTarget = {
  kind: "user" | "channel";
  id: string;
  normalized: string;
};

export function parseSlackTarget(
  raw: string,
  options: { defaultKind?: "user" | "channel" } = {},
): SlackTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention) return { kind: "user", id: mention[1], normalized: `user:${mention[1].toLowerCase()}` };
  const channelMention = trimmed.match(/^<#([A-Z0-9]+)>$/i);
  if (channelMention) return { kind: "channel", id: channelMention[1], normalized: `channel:${channelMention[1].toLowerCase()}` };
  const prefixed = trimmed.match(/^(user|channel|slack):(.+)$/i);
  if (prefixed) {
    const rawKind = prefixed[1].toLowerCase();
    const id = prefixed[2].replace(/^[@#]/, "").trim();
    const kind = rawKind === "user" ? "user" : rawKind === "channel" ? "channel" : options.defaultKind ?? "channel";
    return id ? { kind, id, normalized: `${kind}:${id.toLowerCase()}` } : null;
  }
  const kind = trimmed.startsWith("@") ? "user" : trimmed.startsWith("#") ? "channel" : options.defaultKind ?? "channel";
  const id = trimmed.replace(/^[@#]/, "");
  return { kind, id, normalized: `${kind}:${id.toLowerCase()}` };
}
