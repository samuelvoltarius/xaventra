export const WA_WEB_AUTH_DIR = ".nova/web-auth";

export function createWaSocket(): unknown {
  return {};
}

export async function loginWeb(): Promise<void> {}
export function logWebSelfId(): void {}
export async function monitorWebInbox(): Promise<void> {}
export async function monitorWebChannel(): Promise<void> {}
export function pickWebChannel(): string {
  return "whatsapp";
}
export async function sendMessageWhatsApp(): Promise<{ channel: string }> {
  return { channel: "whatsapp" };
}
export async function waitForWaConnection(): Promise<void> {}
export function webAuthExists(): boolean {
  return false;
}
