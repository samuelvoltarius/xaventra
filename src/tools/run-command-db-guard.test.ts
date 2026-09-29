import { beforeEach, describe, expect, it, vi } from 'vitest'

const guard = vi.hoisted(() => ({ mode: 'throw' as 'throw' | 'block' | 'allow' }))
vi.mock('../layers/L8-prisma-guards.js', () => ({
    default: {
        checkDatabaseSafety: () => {
            if (guard.mode === 'throw') throw new Error('guard module failed to load')
            return guard.mode === 'block'
                ? { blocked: true, reason: 'prisma migrate reset löscht die Datenbank', suggestion: 'Backup zuerst' }
                : { blocked: false }
        },
    },
}))
const child = vi.hoisted(() => ({ execSync: vi.fn(() => 'ran\n') }))
vi.mock('node:child_process', async (original) => ({ ...(await original() as object), execSync: child.execSync }))

import { systemTools } from './complete-registry.js'

const runCommand = (command: string) => systemTools.find(tool => tool.name === 'run_command')!.handler({ command }) as Promise<string>
beforeEach(() => { child.execSync.mockClear(); guard.mode = 'throw' })

describe('R2 UEB-7: run_command database guard is fail-closed and honest', () => {
    it('does not run anything when the guard cannot be loaded or evaluated', async () => {
        const result = await runCommand('echo harmless')
        expect(result).toMatch(/nicht ausgeführt/)
        expect(child.execSync).not.toHaveBeenCalled()
    })
    it('a blocked command does not promise a confirmation path that does not exist', async () => {
        guard.mode = 'block'
        const result = await runCommand('npx prisma migrate reset --force')
        expect(result).toMatch(/blockiert/)
        expect(result).not.toMatch(/explicit confirmation|Bestätigung .*override/i)
        expect(result).toMatch(/keine? Freigabe|gibt es nicht/)
        expect(child.execSync).not.toHaveBeenCalled()
    })
})
