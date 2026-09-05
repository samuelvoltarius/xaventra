import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionWorkspaceManager } from './mission-workspace.js'

describe('mission workspace manager', () => {
    it('isolates temporary execution and persists review state', async () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-workspaces-'))
        const manager = new MissionWorkspaceManager(root)
        const workspace = await manager.create({ missionId: 'safe-test', mode: 'temporary' })
        const command = process.execPath
        const result = await manager.run(workspace.id, command, ['-e', 'process.stdout.write(process.env.NOVA_MISSION_WORKSPACE || "")'])
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(workspace.id)
        expect(manager.get(workspace.id)?.status).toBe('awaiting-review')
        await manager.retire(workspace.id)
        expect(manager.get(workspace.id)?.status).toBe('retired')
        rmSync(root, { recursive: true, force: true })
    })

    it('requires approval before promotion', async () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-workspaces-'))
        const manager = new MissionWorkspaceManager(root)
        const workspace = await manager.create({ missionId: 'plain', mode: 'temporary' })
        await expect(manager.promote(workspace.id, root, false)).rejects.toThrow(/approval/)
        rmSync(root, { recursive: true, force: true })
    })
})
