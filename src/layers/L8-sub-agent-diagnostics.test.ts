import { describe, expect, it, vi } from 'vitest'

const execSync = vi.fn(() => '')
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), execSync }))

const { getSubAgentManager } = await import('./L8-sub-agent.js')

describe('L8 sub-agent diagnostics host injection (R2 L19)', () => {
    it('never puts an unvalidated host into a shell command', async () => {
        await getSubAgentManager().runToolDiagnostics('ssh_command', { host: '1.2.3.4;touch /tmp/r2-l19' })
        const commands = execSync.mock.calls.map(call => String((call as unknown[])[0]))
        expect(commands.some(command => command.includes('touch /tmp/r2-l19'))).toBe(false)
    })
})
