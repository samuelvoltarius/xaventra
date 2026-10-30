import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPorts } from './collect.js'
import { formatReportCompact } from './format.js'

// 2.92.2 (Abnahme 2.92.0): /doctor zeigte „✅ Alles OK“ neben 4 Warnungen und bot als sicheren Fix „Port 18789 → 18790“
// an - das kollidiert mit Even G2, und „belegt“ war der eigene Dienst. Ein Port-Wechsel ist nie ein sicherer Fix, der
// eigene Prozess ist kein Konflikt, und die Kopfzeile nennt Warnungen.
let server: Server | undefined
afterEach(async () => { await new Promise<void>(resolve => { if (!server) return resolve(); server.close(() => resolve()) }); server = undefined })
const occupied = async () => {
    server = createServer()
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    return (server!.address() as AddressInfo).port
}
const report = (summary: Record<string, unknown>) => ({ summary, checks: Object.fromEntries(['config', 'env', 'runtime', 'gpu', 'ports', 'providers', 'channels', 'mesh'].map(key => [key, { ok: true, label: key, status: 'ok', issues: [] }])), issues: [] }) as any

describe('/doctor ports', () => {
    it('the own running service is no conflict', async () => {
        const port = await occupied()
        const result = await checkPorts({ server: { port } }, { ownService: true })
        expect(result.issues.filter(item => item.code === 'PORT_REST_OCCUPIED')).toEqual([])
    })
    it('a foreign process gets a hint, never a safe port change', async () => {
        const port = await occupied()
        const issue = (await checkPorts({ server: { port } }, { ownService: false })).issues.find(item => item.code === 'PORT_REST_OCCUPIED')!
        expect(issue.fix).toMatchObject({ type: 'info', safe: false })
        expect((issue.fix as any).configValue).toBeUndefined()
    })
})

describe('/doctor headline', () => {
    it('warnings are named, not "Alles OK"', () => {
        const text = formatReportCompact(report({ errors: 0, warnings: 4, infos: 0, ok: 8, healthy: true }))
        expect(text).toMatch(/⚠️ 4 Warnung/)
        expect(text).not.toMatch(/Alles OK/)
    })
    it('without findings it stays "Alles OK"', () => {
        expect(formatReportCompact(report({ errors: 0, warnings: 0, infos: 0, ok: 8, healthy: true }))).toMatch(/✅ Alles OK/)
    })
})
