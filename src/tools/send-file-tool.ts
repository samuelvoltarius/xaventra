/**
 * Send File Tool — Send files/photos/documents via Telegram
 *
 * Allows Nova to send any file from the local filesystem to the user
 * via Telegram. Auto-detects file type (photo vs document).
 *
 * Falls back to a text summary when the file doesn't exist or Telegram
 * isn't available, so the tool never silently fails.
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { extname, basename } from 'node:path'

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.log', '.json', '.csv', '.yaml', '.yml', '.toml', '.env', '.sh', '.py', '.ts', '.js'])
const MAX_PHOTO_SIZE = 10 * 1024 * 1024   // 10 MB Telegram limit for photos
const MAX_DOC_SIZE   = 50 * 1024 * 1024   // 50 MB Telegram limit for documents
const MAX_INLINE_CHARS = 3000              // max chars to paste inline as text

export async function executeSendFile(params: Record<string, unknown>): Promise<string> {
    const filePath = String(params.path || params.file || '')
    const caption = params.caption as string | undefined
    const forceDocument = params.as_document === true

    // Allow optional explicit chatId (for multi-user scenarios)
    const explicitChatId = params.chat_id ? String(params.chat_id) : undefined

    if (!filePath) return '❌ Kein Dateipfad angegeben.'
    if (!existsSync(filePath)) return `❌ Datei nicht gefunden: ${filePath}`

    try {
        const stat = statSync(filePath)
        if (!stat.isFile()) return `❌ Kein reguläre Datei: ${filePath}`

        const ext = extname(filePath).toLowerCase()
        const fileName = basename(filePath)
        const fileSize = stat.size

        // Get Telegram adapter
        const { getTelegramAdapter } = await import('../channels/telegram.js')
        const tg = getTelegramAdapter()

        // Telegram not available — fall back to inline text for small text files
        if (!tg) {
            if (TEXT_EXTENSIONS.has(ext) && fileSize <= MAX_INLINE_CHARS * 2) {
                try {
                    const content = readFileSync(filePath, 'utf-8')
                    return `📄 **${fileName}** (Telegram nicht verbunden — Inhalt inline):\n\`\`\`\n${content.slice(0, MAX_INLINE_CHARS)}${content.length > MAX_INLINE_CHARS ? '\n... (abgeschnitten)' : ''}\n\`\`\``
                } catch { /* can't read */ }
            }
            // NovaOS: Der Mensch sitzt vor DIESEM Bildschirm. Eine Datei
            // "zu versenden" ergibt hier keinen Sinn — und ein rotes Kreuz
            // erst recht nicht: es liest sich wie ein Fehlschlag, obwohl die
            // Datei einwandfrei erzeugt wurde. Bei Bildern ist das besonders
            // irrefuehrend, weil ein Bildschirmfoto MEIN Blick ist, kein
            // Versandweg. Am 30.08.2026 im Protokoll gesehen.
            if (process.env.NOVA_OS_MODE === 'true') {
                const istBild = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(fileName)
                return istBild
                    ? `Bild liegt unter ${filePath} (${formatSize(fileSize)}). `
                      + `Es muss nirgendwohin geschickt werden — der Mensch sitzt vor diesem Bildschirm. `
                      + `Wenn ich es anschauen soll, lese ich es mit analyze_image.`
                    : `Datei liegt unter ${filePath} (${formatSize(fileSize)}). `
                      + `Sie ist auf dieser Maschine, kein Versand noetig.`
            }
            return `❌ Telegram nicht verbunden. Datei: ${filePath} (${formatSize(fileSize)})`
        }

        // Determine target chat:
        // 1. Explicit chatId from params (multi-user tool calls)
        // 2. Last active chat from adapter
        const chatId = explicitChatId || tg.getLastActiveChat()
        if (!chatId) {
            return `❌ Kein aktiver Telegram-Chat. Bitte zuerst eine Nachricht senden, dann erneut versuchen.`
        }

        // Size check before attempting upload
        if (fileSize > MAX_DOC_SIZE) {
            return `❌ Datei zu groß für Telegram: ${formatSize(fileSize)} (max 50 MB).\nSpeicherort: ${filePath}`
        }

        const isPhoto = !forceDocument &&
            PHOTO_EXTENSIONS.has(ext) &&
            fileSize <= MAX_PHOTO_SIZE

        const fileCaption = caption || fileName

        if (isPhoto) {
            await tg.sendPhoto(chatId, filePath, fileCaption)
            console.log(`[SendFile] 📤 Photo sent: ${fileName} (${formatSize(fileSize)}) → ${chatId}`)
            return `✅ Foto gesendet: **${fileName}** (${formatSize(fileSize)})`
        } else {
            await tg.sendDocument(chatId, filePath, fileCaption)
            console.log(`[SendFile] 📤 Document sent: ${fileName} (${formatSize(fileSize)}) → ${chatId}`)
            return `✅ Dokument gesendet: **${fileName}** (${formatSize(fileSize)})`
        }

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`[SendFile] ❌ Error: ${msg}`)

        // Telegram-specific errors
        if (msg.includes('DOCUMENT_INVALID') || msg.includes('file_reference')) {
            return `❌ Dateiformat von Telegram nicht unterstützt: ${basename(filePath)}`
        }
        if (msg.includes('FILE_TOO_BIG') || msg.includes('too large')) {
            return `❌ Datei zu groß für Telegram (max 50 MB): ${filePath}`
        }
        if (msg.includes('PEER_ID_INVALID') || msg.includes('chat not found')) {
            return `❌ Ungültige Chat-ID. Versuche es erneut nach einer neuen Nachricht.`
        }
        return `❌ Senden fehlgeschlagen: ${msg}`
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ============================================
// Tool Definition
// ============================================

export const sendFileTool = {
    name: 'send_file',
    description: 'Sendet eine Datei (Foto, Dokument, CSV, PDF, etc.) via Telegram an den Nutzer. Für kleine Textdateien wird der Inhalt inline angezeigt wenn Telegram nicht verfügbar ist.',
    category: 'communication' as const,
    parameters: [
        { name: 'path', type: 'string' as const, description: 'Absoluter Pfad zur Datei', required: true },
        { name: 'caption', type: 'string' as const, description: 'Optionaler Dateiname/Beschriftung', required: false },
        { name: 'as_document', type: 'boolean' as const, description: 'Immer als Dokument senden (nicht als Foto)', required: false },
        { name: 'chat_id', type: 'string' as const, description: 'Optionale Chat-ID (für Multi-User)', required: false },
    ],
    execute: executeSendFile,
}

export default sendFileTool
