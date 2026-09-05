// Gateway WebSocket Client
// Connects to Clawdbot Gateway on Port 18789 using JSON-RPC

export interface GatewayConfig {
    host: string;
    port: number;
    token: string;
    secure?: boolean;
}

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export type GatewayEventHandler = (event: string, data: unknown) => void;

export class GatewayClient {
    private ws: WebSocket | null = null;
    private config: GatewayConfig;
    private requestId = 0;
    private pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private eventHandlers: GatewayEventHandler[] = [];
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000;

    constructor(config: GatewayConfig) {
        this.config = config;
    }

    // Connect to Gateway WebSocket
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const protocol = this.config.secure ? 'wss' : 'ws';
            const url = `${protocol}://${this.config.host}:${this.config.port}/ws?token=${encodeURIComponent(this.config.token)}`;

            try {
                this.ws = new WebSocket(url);

                this.ws.onopen = () => {
                    console.log('[Gateway] Connected');
                    this.reconnectAttempts = 0;
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (error) => {
                    console.error('[Gateway] WebSocket error:', error);
                    reject(new Error('WebSocket connection failed'));
                };

                this.ws.onclose = () => {
                    console.log('[Gateway] Disconnected');
                    this.handleDisconnect();
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    // Handle incoming messages
    private handleMessage(data: string) {
        try {
            const message = JSON.parse(data);

            // Check if it's a response to a pending request
            if (message.id && this.pending.has(message.id)) {
                const handler = this.pending.get(message.id)!;
                this.pending.delete(message.id);

                if (message.error) {
                    handler.reject(new Error(message.error.message));
                } else {
                    handler.resolve(message.result);
                }
                return;
            }

            // Otherwise it's an event/notification
            if (message.method) {
                this.eventHandlers.forEach(handler => {
                    handler(message.method, message.params);
                });
            }
        } catch (error) {
            console.error('[Gateway] Failed to parse message:', error);
        }
    }

    // Handle disconnection with auto-reconnect
    private handleDisconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`[Gateway] Reconnecting in ${this.reconnectDelay}ms... (attempt ${this.reconnectAttempts})`);
            setTimeout(() => {
                this.connect().catch(console.error);
            }, this.reconnectDelay * this.reconnectAttempts);
        }
    }

    // Send JSON-RPC request
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Not connected to Gateway');
        }

        const id = ++this.requestId;
        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.ws!.send(JSON.stringify(request));

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        });
    }

    // Subscribe to Gateway events
    onEvent(handler: GatewayEventHandler) {
        this.eventHandlers.push(handler);
        return () => {
            const index = this.eventHandlers.indexOf(handler);
            if (index > -1) this.eventHandlers.splice(index, 1);
        };
    }

    // Check connection status
    get isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    // Disconnect
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    // === Gateway API Methods ===

    // Run an agent command
    async agentRun(prompt: string, options?: { sessionKey?: string }) {
        return this.call('agent.run', { prompt, ...options });
    }

    // Get status
    async getStatus() {
        return this.call('status');
    }

    // List sessions
    async listSessions() {
        return this.call('sessions.list');
    }

    // Read file
    async fileRead(path: string) {
        return this.call('file.read', { path });
    }

    // Get task queue
    async getTaskQueue() {
        return this.call('tasks.list');
    }

    // Submit task
    async submitTask(description: string, options?: { priority?: string; category?: string }) {
        return this.call('tasks.submit', { description, ...options });
    }

    // Get nodes status (Raspberry Pis)
    async getNodes() {
        return this.call('nodes.list');
    }

    // Restart service
    async restartService(service: string) {
        return this.call('service.restart', { service });
    }
}

// Singleton instance
let gatewayClient: GatewayClient | null = null;

export function getGatewayClient(): GatewayClient {
    if (!gatewayClient) {
        gatewayClient = new GatewayClient({
            host: process.env.NEXT_PUBLIC_GATEWAY_HOST || '192.0.2.12',
            port: parseInt(process.env.NEXT_PUBLIC_GATEWAY_PORT || '18789'),
            token: process.env.NEXT_PUBLIC_GATEWAY_TOKEN || '',
            secure: process.env.NEXT_PUBLIC_GATEWAY_SECURE === 'true',
        });
    }
    return gatewayClient;
}
