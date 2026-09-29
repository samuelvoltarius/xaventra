import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', async (original) => ({ ...(await original() as object), getUserPermission: perms.getUserPermission }))
const child = vi.hoisted(() => ({ spawn: vi.fn(() => { throw new Error('no process in tests') }) }))
vi.mock('node:child_process', async (original) => ({ ...(await original() as object), spawn: child.spawn }))

import { printerTools } from './3dprinter.js'
import { printerPrintTool, printerStatusTool } from './printer-tool.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); child.spawn.mockClear(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => vi.unstubAllGlobals())
const approved = <T>(work: () => T) => withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram', approvalGranted: true }, work)
const tool = (name: string) => printerTools.find(entry => entry.name === name)!

describe('R2 T10: physical printer actions only with owner approval', () => {
    it.each([
        ['printer_start', { filename: 'benchy.gcode' }],
        ['printer_gcode', { gcode: 'M104 S300\nM140 S110' }],
        ['printer_resume', {}],
    ])('%s refuses without approval (owner without code, admin with a made-up code)', async (name, params) => {
        for (const identity of [{ authorizationUserId: 'owner-1' }, { authorizationUserId: 'admin-1', confirm: 'ok' }]) {
            const result = await tool(name).handler({ ...params, ...identity, channel: 'telegram' }) as any
            expect(result.success).toBe(false)
        }
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it('printer_print refuses without approval and never touches the network', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gcode-'))
        const gcode = join(dir, 'part.gcode')
        writeFileSync(gcode, 'G28\n')
        const result = await printerPrintTool.handler({ printerUrl: 'http://192.0.2.5', gcodeFile: gcode, apiKey: 'k', authorizationUserId: 'owner-1', channel: 'telegram' }) as any
        expect(result.success).toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('R2 T9: printer-tool builds no shell strings and uploads only G-code', () => {
    it('refuses non-G-code files (config exfiltration) even with approval', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gcode-'))
        const config = join(dir, 'xaventra.config.json')
        writeFileSync(config, '{"telegram":{"token":"secret"}}')
        const result = await approved(() => printerPrintTool.handler({ printerUrl: 'https://evil.example', gcodeFile: config, apiKey: 'x' })) as any
        expect(result.success).toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it('refuses shell-shaped printer URLs and never spawns a shell for status', async () => {
        const result = await printerStatusTool.handler({ printerUrl: 'x" & calc & "' }) as any
        expect(result.success).toBe(false)
        fetchMock.mockResolvedValueOnce(new Response('{"result":{"status":{"toolhead":{},"temperature":1}}}', { status: 200 }))
        const ok = await printerStatusTool.handler({ printerUrl: 'http://192.0.2.5:7125', apiKey: 'a"b' }) as any
        expect(ok.success).toBe(true)
        expect(fetchMock.mock.calls[0][0]).toBe('http://192.0.2.5:7125/printer/objects/query?heater_bed&toolhead&print_stats')
        expect(child.spawn).not.toHaveBeenCalled()
    })
})

describe('R2 T18: honest print result and a single printer_status', () => {
    it('reports failure when the printer rejects the start request', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gcode-'))
        const gcode = join(dir, 'part.gcode')
        writeFileSync(gcode, 'G28\n')
        fetchMock.mockResolvedValueOnce(new Response('ok', { status: 201 }))
        fetchMock.mockResolvedValueOnce(new Response('conflict', { status: 409 }))
        const result = await approved(() => printerPrintTool.handler({ printerUrl: 'http://192.0.2.5', gcodeFile: gcode, apiKey: 'k' })) as any
        expect(result.success).toBe(false)
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ command: 'start' })
    })
    it('registers the configured printer_status, not the legacy URL-based one', async () => {
        const { ALL_TOOLS } = await import('./complete-registry.js')
        const entries = ALL_TOOLS.filter(entry => entry.name === 'printer_status')
        expect(entries).toHaveLength(1)
        expect(entries[0]).not.toBe(printerStatusTool)
    })
})
