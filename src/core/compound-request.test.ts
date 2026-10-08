import { describe, expect, it } from 'vitest'
import { compoundRemainder } from './request-capabilities.js'
import { getRelevantTools } from '../tools/tool-router.js'
import { compoundNodeScreenshotResponse, nodeScreenshotResponse } from './tool-evidence-response.js'

describe('2.89.3 compound requests', () => {
    it('finds the second task, and nothing in a single task', () => {
        expect(compoundRemainder('Send mir eine screen Shot von alleine nodes wo es geht und wenn du schon dabei bist Google nach mir')).toBe('Google nach mir')
        expect(compoundRemainder('Mach einen Screenshot und außerdem such das Wetter in Wien')).toBe('such das Wetter in Wien')
        expect(compoundRemainder('Wie spät ist es und wie ist das Wetter in Wien?')).toBe('wie ist das Wetter in Wien?')
        expect(compoundRemainder('Screenshot von allen Nodes und Main')).toBeNull()
        expect(compoundRemainder('Was können deine nodes? send mir einen screnn shot vbon jeden')).toBeNull()
    })

    it('router: the screenshot contract also offers the tools of the second task, but no other way to capture', () => {
        const names = getRelevantTools('Send mir eine screen Shot von alleine nodes wo es geht und wenn du schon dabei bist Google nach mir').map(tool => tool.name)
        expect(names).toContain('mesh_screenshot')
        expect(names.some(name => /search|google/.test(name))).toBe(true)
        for (const blocked of ['desktop_screenshot', 'send_file', 'ssh_command']) expect(names).not.toContain(blocked)
    })

    it('answer: second task not done is said openly; done is answered from its result', () => {
        const shots = { toolName: 'mesh_screenshot', success: true, result: { captures: [{ nodeId: 'spark', captured: true, delivered: true }] } }
        const none = compoundNodeScreenshotResponse([shots], 'Google nach mir', 'Screenshots gesendet.')
        expect(none).toContain('spark: Bild gesendet')
        expect(none).toMatch(/Den zweiten Teil \(„Google nach mir“\) habe ich nicht geschafft\. Soll ich es noch einmal versuchen\?/)
        const done = compoundNodeScreenshotResponse([shots, { toolName: 'web_search', success: true, result: 'Alfred Aigner: Fotograf in Salzburg' }], 'Google nach mir', 'Zu dir finde ich: Fotograf in Salzburg.')
        expect(done).toContain('Zu dir finde ich: Fotograf in Salzburg.')
        expect(done).not.toContain('nicht geschafft')
    })

    it('screenshot lines are short, nodes with a picture first', () => {
        const text = nodeScreenshotResponse([{ toolName: 'mesh_screenshot', success: false, result: { captures: [
            { nodeId: 'ns1', captured: false, delivered: false, error: 'Node capture not enrolled; headless' },
            { nodeId: 'spark', captured: true, delivered: true },
            { nodeId: 'lab', captured: true, delivered: false },
        ] } }])
        expect(text.split('\n')).toEqual(['spark: Bild gesendet', 'lab: Bild aufgenommen, Zustellung nicht bestätigt', 'ns1: Server ohne Bildschirm – kein Bild möglich'])
    })
})
