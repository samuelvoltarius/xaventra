import { describe, expect, it } from 'vitest'
import { nodeScreenshotResponse } from './tool-evidence-response.js'

// 2.87.1 (live 07.10.2026): the Spark picture reached Telegram, another node had no
// picture; the runner prefixed the result with "❌ Ergebnis nicht verifiziert … Rohdaten:",
// the per-node receipts were lost and the reply said no image was transferred at all.

describe('node screenshot reply keeps per-node truth behind the verification prefix', () => {
    const raw = JSON.stringify({ success: false, captured: true, delivered: false, captures: [
        { nodeId: 'node-a', captured: true, delivered: true },
        { nodeId: 'node-b', captured: false, delivered: false, error: 'kein Bildschirm' },
    ] })
    it('reports the delivered picture and the missing one', () => {
        const text = nodeScreenshotResponse([{ toolName: 'mesh_screenshot', success: false, result: `❌ Ergebnis nicht verifiziert: tool reported failure. Rohdaten: ${raw}` }])
        expect(text).toContain('node-a: Bild gesendet')
        expect(text).toContain('node-b: ')
        expect(text).not.toContain('In diesem Lauf wurde keine Bilddatei')
        expect(text).not.toContain('Node-Fähigkeiten')
    })
})
