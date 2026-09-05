export function isWhatsAppGroupJid(id: string): boolean {
  return id.endsWith("@g.us");
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}
