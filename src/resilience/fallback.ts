/**
 * Nova - Offline Fallback Mode
 * 
 * Allows Nova to function even WITHOUT a connected LLM model.
 * Basic commands (/help, /status, /reconnect) still work.
 * 
 * This is part of Layer 0 (Resilience Layer).
 */

import { processCommand, getAllCommands, getBotInfo } from '../commands/builtin.js'
import type { IncomingMessage } from '../core/types.js'

// ============================================
// Types
// ============================================

export type OperationMode = 'online' | 'degraded' | 'offline'

export interface FallbackState {
    mode: OperationMode
    llmConnected: boolean
    channelsConnected: string[]
    lastOnlineTime?: number
    offlineReason?: string
}

// ============================================
// Offline Responses
// ============================================

const OFFLINE_RESPONSES: Record<string, string> = {
    greeting: `⚠️ **Nova läuft im Offline-Modus**

Ich kann gerade keine AI-Antworten generieren, aber meine Basis-Befehle funktionieren:

\`/help\` - Hilfe anzeigen
\`/status\` - Status prüfen
\`/reconnect\` - Verbindung neu aufbauen
\`/model\` - Modell wechseln`,

    noLlm: `🔌 **Kein LLM verbunden**

Ich kann deine Nachricht nicht verarbeiten, weil kein AI-Modell verbunden ist.

Versuche:
1. \`/reconnect\` um die Verbindung wiederherzustellen
2. \`/model <name>\` um ein anderes Modell zu wählen
3. \`/status\` um den aktuellen Status zu sehen`,

    degraded: `⚠️ **Eingeschränkter Modus**

Einige Funktionen sind gerade nicht verfügbar:
{issues}

Basis-Befehle funktionieren weiterhin.`,
}

// ============================================
// Fallback Manager Class
// ============================================

export class FallbackManager {
    private state: FallbackState = {
        mode: 'offline',
        llmConnected: false,
        channelsConnected: [],
    }

    // ============================================
    // State Management
    // ============================================

    setLLMConnected(connected: boolean): void {
        this.state.llmConnected = connected
        this.updateMode()

        if (connected) {
            this.state.lastOnlineTime = Date.now()
            console.log('[Nova Fallback] LLM connected - going online')
        } else {
            this.state.offlineReason = 'LLM disconnected'
            console.log('[Nova Fallback] LLM disconnected - entering fallback mode')
        }
    }

    addChannel(channelType: string): void {
        if (!this.state.channelsConnected.includes(channelType)) {
            this.state.channelsConnected.push(channelType)
            this.updateMode()
        }
    }

    removeChannel(channelType: string): void {
        this.state.channelsConnected = this.state.channelsConnected.filter(c => c !== channelType)
        this.updateMode()
    }

    private updateMode(): void {
        if (this.state.llmConnected && this.state.channelsConnected.length > 0) {
            this.state.mode = 'online'
        } else if (this.state.channelsConnected.length > 0) {
            this.state.mode = 'degraded'
        } else {
            this.state.mode = 'offline'
        }
    }

    getState(): FallbackState {
        return { ...this.state }
    }

    getMode(): OperationMode {
        return this.state.mode
    }

    isOnline(): boolean {
        return this.state.mode === 'online'
    }

    // ============================================
    // Message Processing
    // ============================================

    /**
     * Process a message in fallback mode
     * Returns a response if handled, null if should pass to LLM
     */
    async processMessage(msg: IncomingMessage): Promise<string | null> {
        // Always handle commands, even in fallback mode
        if (msg.content.startsWith('/')) {
            const commandResponse = await processCommand(msg)
            if (commandResponse) {
                return commandResponse
            }
        }

        // If LLM is not connected, return fallback response
        if (!this.state.llmConnected) {
            return this.getOfflineResponse(msg)
        }

        // Pass to LLM (return null)
        return null
    }

    /**
     * Get an appropriate offline response
     */
    private getOfflineResponse(msg: IncomingMessage): string {
        const content = msg.content.toLowerCase()

        // Greetings
        if (/^(hi|hallo|hey|guten|servus|moin)/i.test(content)) {
            return OFFLINE_RESPONSES.greeting
        }

        // Default: no LLM response
        return OFFLINE_RESPONSES.noLlm
    }

    // ============================================
    // Status Information
    // ============================================

    getStatusMessage(): string {
        const botInfo = getBotInfo()
        const commands = getAllCommands()

        let status = `**${botInfo.emoji} ${botInfo.name} Status**\n\n`

        // Mode
        const modeEmoji = {
            online: '🟢',
            degraded: '🟡',
            offline: '🔴',
        }[this.state.mode]

        status += `**Modus:** ${modeEmoji} ${this.state.mode.toUpperCase()}\n`
        status += `**LLM:** ${this.state.llmConnected ? '✅ Verbunden' : '❌ Nicht verbunden'}\n`

        // Channels
        if (this.state.channelsConnected.length > 0) {
            status += `**Channels:** ${this.state.channelsConnected.join(', ')}\n`
        } else {
            status += `**Channels:** Keine verbunden\n`
        }

        // Last online
        if (this.state.lastOnlineTime) {
            const ago = Math.round((Date.now() - this.state.lastOnlineTime) / 1000)
            status += `**Letzte Verbindung:** vor ${ago}s\n`
        }

        // Available commands
        status += `\n**Verfügbare Befehle (${commands.length}):**\n`
        status += commands.map(c => `\`/${c.name}\``).join(' ')

        return status
    }

    // ============================================
    // Reconnection
    // ============================================

    async attemptReconnect(
        reconnectLLM: () => Promise<boolean>,
        reconnectChannels: () => Promise<string[]>
    ): Promise<{
        success: boolean
        llmConnected: boolean
        channelsConnected: string[]
    }> {
        console.log('[Nova Fallback] Attempting reconnection...')

        let llmSuccess = false
        let channels: string[] = []

        try {
            llmSuccess = await reconnectLLM()
            this.setLLMConnected(llmSuccess)
        } catch (err) {
            console.error('[Nova Fallback] LLM reconnect failed:', err)
        }

        try {
            channels = await reconnectChannels()
            this.state.channelsConnected = channels
            this.updateMode()
        } catch (err) {
            console.error('[Nova Fallback] Channel reconnect failed:', err)
        }

        return {
            success: llmSuccess && channels.length > 0,
            llmConnected: llmSuccess,
            channelsConnected: channels,
        }
    }
}

// ============================================
// Factory
// ============================================

export function createFallbackManager(): FallbackManager {
    return new FallbackManager()
}

// ============================================
// Export
// ============================================

export default {
    FallbackManager,
    createFallbackManager,
}
