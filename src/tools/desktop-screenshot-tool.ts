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

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { getDesktopAgentContext } from '../desktop/desktop-agent-context.js'
import { getDesktopControlQueue } from '../desktop/desktop-control.js'

function captureDesktop(filePath: string): void {
    const isWin = process.platform === 'win32'
    if (isWin) {
        // PowerShell native — union of all monitors, no external deps
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$bounds = [System.Drawing.Rectangle]::Empty
foreach ($s in $screens) { $bounds = [System.Drawing.Rectangle]::Union($bounds, $s.Bounds) }
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save('${filePath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'OK'`
        execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, '; ')}"`, { timeout: 15000 })
    } else if (process.platform === 'darwin') {
        execSync(`screencapture -x "${filePath}"`, { timeout: 10000 })
    } else {
        execSync(`import -window root "${filePath}" 2>/dev/null || scrot "${filePath}"`, { timeout: 10000 })
    }
}

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
            const visionDir = join(process.cwd(), '.nova-vision')
            if (!existsSync(visionDir)) mkdirSync(visionDir, { recursive: true })

            const fileName = (params.name as string) || `desktop_${Date.now()}`
            const filePath = join(visionDir, `${fileName}.png`)

            captureDesktop(filePath)

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
            if (params.send !== false) {
                try {
                    const { executeSendFile } = await import('./send-file-tool.js')
                    const sendResult = await executeSendFile({
                        path: filePath,
                        caption: 'Screenshot vom Desktop 📸',
                        chat_id: params.chat_id,
                    })
                    sentMsg = ` | ${sendResult}`
                    console.log(`[Desktop] 📤 ${sendResult}`)
                } catch (sendErr) {
                    sentMsg = ` | ⚠️ Senden fehlgeschlagen: ${sendErr}`
                    console.log(`[Desktop] ⚠️ Auto-send failed: ${sendErr}`)
                }
            }

            return {
                success: true,
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
