import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { environmentOverviewPlan } from './environment-overview.js'
const input = { content: 'send mir was du im netzwerk findest und wo mit du dich verbinden kannst mesh netzwerk und local',
    permission: 'owner', internal: false, hasImage: false, constrained: false,
    tools: [{ name: 'environment_inventory' }, { name: 'mesh_status' }] }
describe('bounded deterministic owner inventory', () => {
    it('performs a fresh governed device scan before inventory for the actual test request', () => {
        const content = 'Prüfe jetzt erneut, welche Geräte in meinem lokalen Netzwerk und im Mesh verfügbar sind. Noch nichts koppeln, installieren oder schalten.'
        expect(environmentOverviewPlan({ ...input, content, tools: [...input.tools, { name: 'scan_now' }] })).toEqual([
            { name: 'scan_now', arguments: { was: 'geraete' } },
            { name: 'environment_inventory', arguments: {} }, { name: 'mesh_status', arguments: {} },
        ])
        expect(environmentOverviewPlan({ ...input, content })).toBeNull()
        expect(environmentOverviewPlan({ ...input, content: content + ' Installiere danach etwas.', tools: [...input.tools, { name: 'scan_now' }] })).toBeNull()
    })
    it('plans only stored discovery and current Mesh status, never a scan or a write', () => {
        expect(environmentOverviewPlan(input)).toEqual([{ name: 'environment_inventory', arguments: {} }, { name: 'mesh_status', arguments: {} }])
    })
    it('cannot broaden a restricted tool contract or disclose owner data to another principal', () => {
        for (const patch of [{ permission: 'user' }, { permission: 'guest' }, { internal: true }, { hasImage: true },
            { constrained: true }, { tools: [] }, { tools: [{ name: 'mesh_status' }] },
            { content: input.content + ' und kopiere bericht.txt an ns2' }]) expect(environmentOverviewPlan({ ...input, ...patch })).toBeNull()
    })
    it('uses the same governed executor, abort checks and completion ledger, not raw registry execution', () => {
        const source = readFileSync(new URL('./nova-runner.ts', import.meta.url), 'utf8')
        const branch = source.slice(source.indexOf('if (overviewPlan) {'), source.indexOf('} else finalContent = await runGovernedSdkLoop'))
        expect(branch).toContain('abortSignal?.aborted')
        expect(branch).toContain('await executeSdkTool(')
        expect(branch).not.toContain('registry.execute')
        expect(source).toContain('outcomeLedger.recordTool(kernel.contract.id')
    })
})
