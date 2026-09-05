import { EventEmitter } from "node:events";
import { vi } from "vitest";
export function createMockBaileys() {
    const sockets = [];
    const makeWASocket = vi.fn((_opts) => {
        const ev = new EventEmitter();
        const sock = {
            ev,
            ws: { close: vi.fn() },
            sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
            sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg123" } }),
            readMessages: vi.fn().mockResolvedValue(undefined),
            user: { id: "123@s.whatsapp.net" },
        };
        setImmediate(() => ev.emit("connection.update", { connection: "open" }));
        sockets.push(sock);
        return sock;
    });
    const mod = {
        DisconnectReason: { loggedOut: 401 },
        fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [1, 2, 3] }),
        makeCacheableSignalKeyStore: vi.fn((keys) => keys),
        makeWASocket,
        useMultiFileAuthState: vi.fn(async () => ({
            state: { creds: {}, keys: {} },
            saveCreds: vi.fn(),
        })),
        jidToE164: (jid) => jid.replace(/@.*$/, "").replace(/^/, "+"),
        downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("img")),
    };
    return {
        mod,
        lastSocket: () => {
            const last = sockets.at(-1);
            if (!last) {
                throw new Error("No Baileys sockets created");
            }
            return last;
        },
    };
}
//# sourceMappingURL=baileys.js.map