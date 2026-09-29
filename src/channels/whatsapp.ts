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

/** Digits of the user part of a JID or phone entry (`+43 660…`, `43660…:12@s.whatsapp.net`). */
export function normalizeWhatsAppNumber(value: unknown): string {
    const user = String(value ?? '').trim().split('@')[0].split(':')[0]
    return user.replace(/\D/g, '')
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
    private sentMessageIds = new Set<string>()

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
        this.sock.ev.on('messages.upsert', (m: any) => this.handleUpsert(m))
    }

    /**
     * H-4/M-4/N-6: admission policy for one `messages.upsert` event.
     * - only live deliveries (`type: 'notify'`); `append` echoes Nova's own
     *   sends and history sync, which must never re-enter as input
     * - `fromMe` only in the owner's own self-chat, and never a message this
     *   adapter sent itself
     * - DMs and groups only from exact allowFrom numbers; empty allowFrom
     *   admits nobody but the self-chat (fail-closed)
     * - groups: `deny` drops, `mention-only` needs an explicit @mention of the
     *   linked account; the sender identity is the participant, not the group
     * - every message of a batch is handled, not only the first
     */
    handleUpsert(m: any): void {
        if (m?.type !== 'notify' || !Array.isArray(m.messages)) return
        for (const msg of m.messages) {
            const incoming = this.admit(msg)
            if (incoming && this.messageHandler) this.messageHandler(incoming)
        }
    }

    private admit(msg: any): IncomingMessage | null {
        const key = msg?.key
        const remoteJid = String(key?.remoteJid || '')
        if (!key?.id || !remoteJid) return null
        if (this.sentMessageIds.has(key.id)) return null

        const content = msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            ''
        if (!content) return null

        const own = normalizeWhatsAppNumber(this.sock?.user?.id)
        const isGroup = remoteJid.endsWith('@g.us')

        if (key.fromMe) {
            const selfChat = !isGroup && Boolean(own) && normalizeWhatsAppNumber(remoteJid) === own
            if (!selfChat || !this.config.selfChatMode) return null
            return this.toIncoming(msg, remoteJid, content, false)
        }

        const senderJid = isGroup ? String(key.participant || msg.participant || '') : remoteJid
        const sender = normalizeWhatsAppNumber(senderJid)
        const allowed = (this.config.allowFrom || []).map(normalizeWhatsAppNumber).filter(Boolean)
        if (!sender || !allowed.includes(sender)) {
            console.log(`[Nova WhatsApp] Ignoring message from non-allowed: ${sender || '?'}${isGroup ? ' (group)' : ''}`)
            return null
        }

        if (isGroup) {
            const policy = this.config.groupPolicy || 'mention-only'
            if (policy === 'deny') return null
            if (policy === 'mention-only') {
                const mentioned: string[] = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
                const ownIds = [own, normalizeWhatsAppNumber(this.sock?.user?.lid)].filter(Boolean)
                if (!mentioned.some(jid => ownIds.includes(normalizeWhatsAppNumber(jid)))) return null
            }
            return this.toIncoming(msg, senderJid, content, true, remoteJid)
        }
        return this.toIncoming(msg, remoteJid, content, false)
    }

    private toIncoming(msg: any, from: string, content: string, isGroup: boolean, groupId?: string): IncomingMessage {
        return {
            id: msg.key.id!,
            channel: 'whatsapp',
            from,
            content,
            timestamp: Number(msg.messageTimestamp) * 1000,
            isGroup,
            groupId,
        }
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

        // M-3: close the socket only. logout() unlinks the companion device and
        // would force a new QR scan after every leadership change.
        if (this.sock) {
            try { this.sock.end(undefined) } catch { /* ignore */ }
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

        const sent = await this.sock.sendMessage(jid, { text: msg.content })
        // H-4: remember own message ids so an echo can never become input.
        if (sent?.key?.id) {
            this.sentMessageIds.add(sent.key.id)
            if (this.sentMessageIds.size > 500) this.sentMessageIds.delete(this.sentMessageIds.values().next().value)
        }
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
