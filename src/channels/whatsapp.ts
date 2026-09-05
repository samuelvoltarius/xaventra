/**
 * Nova - WhatsApp Channel Adapter
 * 
 * Uses @whiskeysockets/baileys for WhatsApp Web connection
 * Provides simplified interface for Nova runtime
 */

import type { ChannelAdapter } from '../core/runtime.js'
import type { IncomingMessage, OutgoingMessage } from '../core/types.js'

// ============================================
// Types
// ============================================

export interface WhatsAppConfig {
    authStatePath?: string
    allowFrom?: string[]
    groupPolicy?: 'allow' | 'mention-only' | 'deny'
    selfChatMode?: boolean
}

interface WhatsAppState {
    connected: boolean
    qrCode?: string
    phoneNumber?: string
}

// ============================================
// WhatsApp Adapter Class
// ============================================

export class WhatsAppAdapter implements ChannelAdapter {
    type = 'whatsapp'
    private sock: any = null
    private config: WhatsAppConfig
    private state: WhatsAppState = { connected: false }
    private messageHandler?: (msg: IncomingMessage) => void

    // Reconnect state — exponential backoff, max 10 attempts
    private _reconnectAttempts = 0
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private _intentionalDisconnect = false
    private static readonly MAX_RECONNECT_ATTEMPTS = 10
    private static readonly BASE_RECONNECT_DELAY_MS = 3000   // 3s initial
    private static readonly MAX_RECONNECT_DELAY_MS = 300000  // 5min cap

    constructor(config: WhatsAppConfig = {}) {
        this.config = {
            authStatePath: '.nova-whatsapp-auth',
            allowFrom: [],
            groupPolicy: 'mention-only',
            selfChatMode: true,
            ...config,
        }
    }

    // ============================================
    // Connection
    // ============================================

    async connect(): Promise<void> {
        console.log('[Nova WhatsApp] Connecting...')
        this._intentionalDisconnect = false

        // Dynamic import for Baileys
        const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } =
            await import('@whiskeysockets/baileys')

        // Load or create auth state
        const { state, saveCreds } = await useMultiFileAuthState(this.config.authStatePath!)

        // Create socket with connection-quality settings
        this.sock = makeWASocket({
            auth: state,
            connectTimeoutMs: 30000,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
        })

        // Handle connection updates
        this.sock.ev.on('connection.update', async (update: any) => {
            const { connection, lastDisconnect, qr } = update

            if (qr) {
                this.state.qrCode = qr
                console.log('')
                console.log('╔════════════════════════════════════════════════════════════╗')
                console.log('║           📱 WHATSAPP QR CODE - SCAN WITH YOUR PHONE       ║')
                console.log('╠════════════════════════════════════════════════════════════╣')
                console.log('║                                                            ║')
                try {
                    const qrcode = await import('qrcode')
                    const qrString = await qrcode.toString(qr, { type: 'terminal', small: true })
                    console.log(qrString)
                } catch {
                    console.log(`║  ${qr.slice(0, 50)}...                                     ║`)
                }
                console.log('║                                                            ║')
                console.log('║  1. Öffne WhatsApp auf deinem Handy                        ║')
                console.log('║  2. Gehe zu Einstellungen > Verknüpfte Geräte              ║')
                console.log('║  3. Tippe auf "Gerät verknüpfen"                           ║')
                console.log('║  4. Scanne diesen QR-Code                                  ║')
                console.log('╚════════════════════════════════════════════════════════════╝')
                console.log('')
            }

            if (connection === 'close') {
                this.state.connected = false
                const statusCode = lastDisconnect?.error?.output?.statusCode
                const isLoggedOut = statusCode === DisconnectReason.loggedOut

                if (this._intentionalDisconnect || isLoggedOut) {
                    console.log(`[Nova WhatsApp] ${isLoggedOut ? '🚪 Ausgeloggt' : '🛑 Absichtlich getrennt'} — kein Reconnect`)
                    return
                }

                this._scheduleReconnect()

            } else if (connection === 'open') {
                this.state.connected = true
                this._reconnectAttempts = 0  // Reset on success
                if (this._reconnectTimer) {
                    clearTimeout(this._reconnectTimer)
                    this._reconnectTimer = null
                }
                this.state.phoneNumber = this.sock.user?.id?.split(':')[0]
                console.log(`[Nova WhatsApp] ✅ Verbunden als ${this.state.phoneNumber}`)
            }
        })

        // Save credentials on update
        this.sock.ev.on('creds.update', saveCreds)

        // Handle incoming messages
        this.sock.ev.on('messages.upsert', async (m: any) => {
            if (!m.messages?.[0]) return

            const msg = m.messages[0]
            if (msg.key.fromMe && !this.config.selfChatMode) return

            const content = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                ''

            if (!content) return

            const from = msg.key.remoteJid!
            const isGroup = from.endsWith('@g.us')

            // Check allowlist
            if (!isGroup && this.config.allowFrom?.length) {
                const senderPhone = from.split('@')[0]
                if (!this.config.allowFrom.some(p => p.includes(senderPhone))) {
                    console.log(`[Nova WhatsApp] Ignoring message from non-allowed: ${senderPhone}`)
                    return
                }
            }

            // Create incoming message
            const incoming: IncomingMessage = {
                id: msg.key.id!,
                channel: 'whatsapp',
                from,
                content,
                timestamp: msg.messageTimestamp as number * 1000,
                isGroup,
                groupId: isGroup ? from : undefined,
            }

            // Call handler
            if (this.messageHandler) {
                this.messageHandler(incoming)
            }
        })
    }

    // ============================================
    // Reconnect Logic — Exponential Backoff
    // ============================================

    private _scheduleReconnect(): void {
        if (this._reconnectAttempts >= WhatsAppAdapter.MAX_RECONNECT_ATTEMPTS) {
            console.error(`[Nova WhatsApp] ❌ Max Reconnect-Versuche (${WhatsAppAdapter.MAX_RECONNECT_ATTEMPTS}) erreicht. Aufgegeben.`)
            console.error('[Nova WhatsApp] Starte Nova neu oder scanne QR erneut um WhatsApp zu verwenden.')
            return
        }

        // Exponential backoff: 3s, 6s, 12s, 24s, 48s, 96s, ... max 5min
        const delay = Math.min(
            WhatsAppAdapter.BASE_RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempts),
            WhatsAppAdapter.MAX_RECONNECT_DELAY_MS
        )
        this._reconnectAttempts++

        console.log(`[Nova WhatsApp] 🔄 Reconnect ${this._reconnectAttempts}/${WhatsAppAdapter.MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s...`)

        // Clear any existing timer
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer)

        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null
            try {
                // Close old socket cleanly before reconnecting
                if (this.sock) {
                    try { this.sock.end(undefined) } catch { /* ignore */ }
                    this.sock = null
                }
                await this.connect()
            } catch (err: any) {
                console.error(`[Nova WhatsApp] Reconnect fehlgeschlagen: ${err.message}`)
                this._scheduleReconnect()  // Try again with longer delay
            }
        }, delay)
    }

    async disconnect(): Promise<void> {
        console.log('[Nova WhatsApp] Trenne Verbindung...')
        this._intentionalDisconnect = true

        // Cancel pending reconnect
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer)
            this._reconnectTimer = null
        }

        if (this.sock) {
            try {
                await this.sock.logout()
            } catch {
                // logout() can fail if already disconnected
                try { this.sock.end(undefined) } catch { /* ignore */ }
            }
            this.sock = null
        }
        this.state.connected = false
        this._reconnectAttempts = 0
    }

    // ============================================
    // Messaging
    // ============================================

    async send(msg: OutgoingMessage): Promise<void> {
        if (!this.sock || !this.state.connected) {
            throw new Error('WhatsApp not connected')
        }

        const jid = msg.to.includes('@') ? msg.to : `${msg.to}@s.whatsapp.net`

        await this.sock.sendMessage(jid, { text: msg.content })
        console.log(`[Nova WhatsApp] Sent message to ${jid.split('@')[0]}`)
    }

    // ============================================
    // Event Handling
    // ============================================

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler
    }

    // ============================================
    // Status
    // ============================================

    isConnected(): boolean {
        return this.state.connected
    }

    getPhoneNumber(): string | undefined {
        return this.state.phoneNumber
    }

    getQRCode(): string | undefined {
        return this.state.qrCode
    }
}

// ============================================
// Factory Function
// ============================================

export function createWhatsAppAdapter(config?: WhatsAppConfig): WhatsAppAdapter {
    return new WhatsAppAdapter(config)
}

// ============================================
// Export
// ============================================

export default {
    WhatsAppAdapter,
    createWhatsAppAdapter,
}
