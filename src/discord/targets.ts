export function resolveDiscordChannelId(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("Discord channel id is required.");
  const mention = value.match(/^<#(\d+)>$/);
  return (mention?.[1] ?? value.replace(/^(discord|channel):/i, "")).trim();
}
