/**
 * Desktop Screenshot Tool — captures the full desktop (all monitors),
 * forwards the image to the LLM for REAL vision analysis, and sends it
 * directly to the user.
 *
 * Why this exists:
 *  - The old `screen_capture` (vision-tool.ts) returned `base64` instead of
 *    `imageBase64`/`imageMimeType`, so nova-runner never forwarded the image
 *    to the vision pipeline → Nova hallucinated the screen content.
 *  - There was no auto-send, so Nova would claim "sent" without sending.
 *
 * This tool returns `imageBase64` + `imageMimeType` (consumed by nova-runner's
 * vision capture) AND auto-sends via Telegram unless send=false.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { getDesktopAgentContext } from '../desktop/desktop-agent-context.js'
import { getDesktopControlQueue } from '../desktop/desktop-control.js'
import { requestSessionCapture } from '../host/capture-agent.js'
import { getExecutionPolicyContext } from '../core/lifecycle-policy.js'

export const desktopScreenshotTool = {
    name: 'desktop_screenshot',
    description: 'Nimm einen Screenshot des gesamten Desktops (alle Monitore) auf. Das Bild wird automatisch an dich (KI) zur echten Bildanalyse weitergeleitet UND direkt an den Nutzer gesendet (sofern send != false). Nutze dies wenn der Nutzer einen Screenshot/Bildschirmfoto möchte oder du sehen willst was auf dem Bildschirm ist.',
    category: 'system' as const,
    parameters: [
        { name: 'name', type: 'string' as const, description: 'Optionaler Dateiname (ohne Endung)', required: false },
        { name: 'send', type: 'boolean' as const, description: 'Screenshot direkt an den Nutzer senden (default: true)', required: false },
    ],
    handler: async (params: Record<string, any>) => {
        try {
            const desktopContext = getDesktopAgentContext()
            if (desktopContext) {
                const queue = getDesktopControlQueue()
                if (!desktopContext.clientId) return { success: false, error: 'Desktop client identity is missing; reconnect Nova Desktop and retry.' }
                const command = queue.enqueue(desktopContext.principalId, 'capture_screen', {}, `desktop-tool:${desktopContext.botId}`, desktopContext.clientId)
                const completed = await queue.waitForCompletion(desktopContext.principalId, command.id, 20_000)
                if (completed.status !== 'acknowledged' || completed.result?.kind !== 'screen_capture') {
                    return { success: false, error: completed.error || `Desktop capture ${completed.status}` }
                }
                const imageBuffer = readFileSync(completed.result.path)
                return {
                    success: true,
                    path: completed.result.path,
                    screenshotPath: completed.result.path,
                    imageBase64: imageBuffer.toString('base64'),
                    imageMimeType: completed.result.mimeType,
                    size: completed.result.size,
                    sha256: completed.result.sha256,
                    source: 'authenticated-desktop-client',
                    message: 'Screenshot wurde vom verbundenen Desktop-Client aufgenommen und per SHA-256 verifiziert. Beschreibe nur sichtbare Bildinhalte.',
                }
            }
            // Defense in depth (H1): the handler enforces the same owner opt-in,
            // principal and channel rule as desktop_input, so a caller that
            // bypasses the governed executor still cannot capture host pixels.
            const policyContext = getExecutionPolicyContext()
            const owner = process.env.NOVA_DESKTOP_TELEGRAM_OWNER_ID
            if (!owner || !/^[1-9][0-9]*$/.test(owner) || policyContext.authUserId !== owner
                || policyContext.channel?.toLowerCase() !== 'telegram' || !policyContext.runId) {
                return { success: false, captured: false, delivered: false,
                    error: 'Desktop screenshot requires the enrolled authenticated Telegram owner and run; nothing was captured' }
            }
            const visionDir = join(process.cwd(), '.nova-vision')
            if (!existsSync(visionDir)) mkdirSync(visionDir, { recursive: true })

            // The model's name is only a prefix. Live 30.09.2026 it reused the name
            // of an earlier capture from the conversation and the exclusive write
            // below failed with EEXIST; every capture now gets a fresh file.
            const prefix = (params.name as string) || 'desktop'
            if (!/^[a-zA-Z0-9_-]{1,60}$/.test(prefix)) return { success: false, error: 'Invalid screenshot name' }
            const fileName = `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`
            const filePath = join(visionDir, `${fileName}.png`)

            if (!process.env.NOVA_CAPTURE_SOCKET && !process.env.NOVA_CAPTURE_TOKEN_FILE) {
                // INT-4: without an enrolled capture adapter nothing is
                // captured. The daemon's own display is never a capture source
                // (it may be a different user's session or a headless host).
                return { success: false, captured: false, delivered: false,
                    error: 'no enrolled capture adapter; local capture disabled' }
            }
            // Workstation enrollment configured (even partially): only the
            // enrolled adapter may capture. Never fall back to the local
            // display on denial, lock, timeout or misconfiguration.
            const image = await requestSessionCapture(process.env.NOVA_CAPTURE_SOCKET || '', process.env.NOVA_CAPTURE_TOKEN_FILE || '')
            writeFileSync(filePath, image, { mode: 0o600, flag: 'wx' })

            if (!existsSync(filePath)) {
                return { success: false, error: 'Screenshot konnte nicht erstellt werden.' }
            }

            const imageBuffer = readFileSync(filePath)
            const base64 = imageBuffer.toString('base64')
            console.log(`[Desktop] 📸 Screenshot: ${filePath} (${(imageBuffer.length / 1024).toFixed(0)} KB)`)

            // Auto-send to the user so we never claim "sent" without sending.
            // Capture stays separate from delivery — the base64 still flows back
            // to the LLM (imageBase64/imageMimeType) for REAL vision analysis.
            let sentMsg = ''
            let delivered = params.send === false
            if (params.send !== false) {
                try {
                    const context = getExecutionPolicyContext()
                    if (context.channel?.toLowerCase() !== 'telegram' || !/^[1-9][0-9]*$/.test(context.authUserId || '')) {
                        throw new Error('Authenticated Telegram recipient missing; image was not sent')
                    }
                    const { executeSendFile } = await import('./send-file-tool.js')
                    const sendResult = await executeSendFile({
                        path: filePath,
                        caption: 'Screenshot vom Desktop 📸',
                        chat_id: context.authUserId,
                    })
                    delivered = /^✅ (?:Foto|Dokument) gesendet:/.test(sendResult)
                    sentMsg = ` | ${sendResult}`
                    console.log(`[Desktop] 📤 ${sendResult}`)
                } catch (sendErr) {
                    sentMsg = ` | ⚠️ Senden fehlgeschlagen: ${sendErr}`
                    console.log(`[Desktop] ⚠️ Auto-send failed: ${sendErr}`)
                }
            }

            return {
                success: delivered,
                captured: true,
                delivered: params.send === false ? false : delivered,
                ...(!delivered ? { error: 'Screenshot captured, but requested delivery was not verified' } : {}),
                path: filePath,
                screenshotPath: filePath,
                imageBase64: base64,
                imageMimeType: 'image/png',
                size: imageBuffer.length,
                message: `Screenshot aufgenommen${sentMsg}. Beschreibe dem Nutzer ehrlich nur was du TATSÄCHLICH auf dem Bild siehst.`,
            }
        } catch (err) {
            return { success: false, error: `Screenshot-Fehler: ${err}` }
        }
    },
}

export default desktopScreenshotTool
