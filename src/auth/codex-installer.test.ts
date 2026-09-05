import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    extractCodexInstallTarget,
    getCodexRuntimeInstallPaths,
    installCodexOnLocalNode,
    isExplicitCodexInstallRequest,
    isLocalCodexInstallTarget,
} from './codex-installer.js'

const originalNodeId = process.env.NOVA_NODE_ID
const originalRuntimeRoot = process.env.NOVA_CODEX_RUNTIME_ROOT
const roots: string[] = []

afterEach(() => {
    if (originalNodeId === undefined) delete process.env.NOVA_NODE_ID
    else process.env.NOVA_NODE_ID = originalNodeId
    if (originalRuntimeRoot === undefined) delete process.env.NOVA_CODEX_RUNTIME_ROOT
    else process.env.NOVA_CODEX_RUNTIME_ROOT = originalRuntimeRoot
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
})

describe('Codex node installer', () => {
    it('extracts local and named targets without guessing a remote node', () => {
        expect(extractCodexInstallTarget('Installiere Codex auf dem aktuellen Main')).toBe('current')
        expect(extractCodexInstallTarget('Installiere Codex auf Spark')).toBe('Spark')
        expect(extractCodexInstallTarget('Installiere Codex am pi5')).toBe('pi5')
    })

    it('requires an explicit install request and recognizes Spark aliases', () => {
        expect(isExplicitCodexInstallRequest('Okay, installiere Codex auf Spark')).toBe(true)
        expect(isExplicitCodexInstallRequest('Ist Codex auf Spark installiert?')).toBe(false)
        expect(isLocalCodexInstallTarget('spark', 'nova-spark', 'container-123')).toBe(true)
        expect(isLocalCodexInstallTarget('gpu-main', 'nova-spark', 'container-123', ['gpu-main'])).toBe(true)
        expect(isLocalCodexInstallTarget('pi5', 'nova-spark', 'container-123')).toBe(false)
    })

    it('installs from the official script into the persistent Nova runtime and verifies the binary', async () => {
        process.env.NOVA_NODE_ID = 'nova-spark'
        const root = join(process.cwd(), '.nova-test-tmp', `codex-installer-${randomUUID()}`)
        roots.push(root)
        process.env.NOVA_CODEX_RUNTIME_ROOT = root
        mkdirSync(root, { recursive: true })
        const paths = getCodexRuntimeInstallPaths('linux')
        let installedBinary: string | null = null
        const script = `#!/bin/sh\n# CODEX_INSTALL_DIR codex\n${'# verified installer payload\n'.repeat(30)}`
        const runFile = vi.fn(async (file: string, args: string[], options: any) => {
            if (file === 'sh') {
                installedBinary = join(String(options.env.CODEX_INSTALL_DIR), 'codex')
                return { stdout: 'installed' }
            }
            expect(args).toEqual(['--version'])
            return { stdout: 'codex-cli 1.2.3\n' }
        })

        const result = await installCodexOnLocalNode({
            targetNode: 'spark',
            requestText: 'Installiere Codex auf Spark',
        }, {
            platform: 'linux',
            allowSideEffectsInTests: true,
            fetch: vi.fn(async () => new Response(script, { status: 200 })) as any,
            runFile,
            probe: vi.fn(async () => true),
            findBinary: () => installedBinary,
        })

        expect(paths.root).toBe(root)
        expect(result).toMatchObject({
            success: true,
            nodeId: 'nova-spark',
            installed: true,
            binary: join(paths.binDir, 'codex'),
            version: 'codex-cli 1.2.3',
        })
        expect(runFile).toHaveBeenCalledTimes(2)
    })

    it('fails closed when the requested target is another node', async () => {
        process.env.NOVA_NODE_ID = 'nova-spark'
        const result = await installCodexOnLocalNode({
            targetNode: 'pi5',
            requestText: 'Installiere Codex auf Pi5',
        }, { platform: 'linux', allowSideEffectsInTests: true })

        expect(result.success).toBe(false)
        expect(result.message).toContain('nicht der lokale Node')
    })
})
