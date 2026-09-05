import { EventEmitter } from "node:events";
import { vi } from "vitest";
export type MockBaileysSocket = {
    ev: EventEmitter;
    ws: {
        close: ReturnType<typeof vi.fn>;
    };
    sendPresenceUpdate: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    readMessages: ReturnType<typeof vi.fn>;
    user?: {
        id?: string;
    };
};
export type MockBaileysModule = {
    DisconnectReason: {
        loggedOut: number;
    };
    fetchLatestBaileysVersion: ReturnType<typeof vi.fn>;
    makeCacheableSignalKeyStore: ReturnType<typeof vi.fn>;
    makeWASocket: ReturnType<typeof vi.fn>;
    useMultiFileAuthState: ReturnType<typeof vi.fn>;
    jidToE164?: (jid: string) => string | null;
    proto?: unknown;
    downloadMediaMessage?: ReturnType<typeof vi.fn>;
};
export declare function createMockBaileys(): {
    mod: MockBaileysModule;
    lastSocket: () => MockBaileysSocket;
};
//# sourceMappingURL=baileys.d.ts.map