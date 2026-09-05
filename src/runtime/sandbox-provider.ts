import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { grantArgs, launcherPath, probe as probeLandlock } from '@deepseek-ai/node-addon-landlock-run'

export interface SandboxPolicy { workspaceRoot: string; network: boolean }
export interface ConfinedCommand { command: string; args: string[]; backend: string; enforcement: 'full' | 'partial' }
export interface SandboxProvider {
    name: string
    supports(): boolean
    confine(command: string, args: string[], policy: SandboxPolicy): ConfinedCommand
}

function commandWorks(command: string, args: string[]): boolean {
    const result = spawnSync(command, args, { timeout: 2_000, windowsHide: true, stdio: 'ignore' })
    return result.status === 0
}

export class BubblewrapSandboxProvider implements SandboxProvider {
    readonly name = 'bubblewrap'
    supports(): boolean { return process.platform === 'linux' && commandWorks('bwrap', ['--version']) }
    confine(command: string, args: string[], policy: SandboxPolicy): ConfinedCommand {
        const root = resolve(policy.workspaceRoot)
        const wrapped = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-uts', '--unshare-ipc']
        if (!policy.network) wrapped.push('--unshare-net')
        wrapped.push('--ro-bind', '/', '/', '--bind', root, root, '--chdir', root, '--proc', '/proc', '--dev', '/dev', '--', command, ...args)
        return { command: 'bwrap', args: wrapped, backend: this.name, enforcement: 'full' }
    }
}

export class LandlockSandboxProvider implements SandboxProvider {
    readonly name = 'landlock'
    private verdict: 'full' | 'partial' | 'unusable' | undefined
    supports(): boolean {
        if (process.platform !== 'linux') return false
        this.verdict ||= probeLandlock(launcherPath(), { timeoutMs: 2_000 })
        return this.verdict !== 'unusable'
    }
    confine(command: string, args: string[], policy: SandboxPolicy): ConfinedCommand {
        if (!this.supports()) throw new Error('Landlock is unavailable on this kernel')
        const grants = grantArgs({ readOnly: ['/'], readWrite: [resolve(policy.workspaceRoot), tmpdir()] })
        return { command: launcherPath(), args: [...grants, '--', command, ...args], backend: this.name, enforcement: this.verdict === 'partial' ? 'partial' : 'full' }
    }
}

export class SeatbeltSandboxProvider implements SandboxProvider {
    readonly name = 'seatbelt'
    supports(): boolean { return process.platform === 'darwin' && commandWorks('sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true']) }
    confine(command: string, args: string[], policy: SandboxPolicy): ConfinedCommand {
        const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const rules = [
            '(version 1)', '(deny default)', '(allow process*)', '(allow file-read*)', '(allow sysctl-read)', '(allow mach-lookup)',
            `(allow file-write* (subpath "${quote(resolve(policy.workspaceRoot))}") (subpath "${quote(tmpdir())}"))`,
            policy.network ? '(allow network*)' : '(deny network*)',
        ].join(' ')
        return { command: 'sandbox-exec', args: ['-p', rules, command, ...args], backend: this.name, enforcement: 'full' }
    }
}

export class SandboxRegistry {
    private readonly providers: SandboxProvider[] = []
    register(provider: SandboxProvider): () => void { this.providers.push(provider); return () => { const i = this.providers.indexOf(provider); if (i >= 0) this.providers.splice(i, 1) } }
    list(): Array<{ name: string; available: boolean }> { return this.providers.map(provider => ({ name: provider.name, available: provider.supports() })) }
    confine(command: string, args: string[], policy: SandboxPolicy, preferred?: string): ConfinedCommand {
        const candidates = preferred ? this.providers.filter(provider => provider.name === preferred) : this.providers
        const provider = candidates.find(item => item.supports())
        if (!provider) throw new Error(`SANDBOX_UNAVAILABLE: ${preferred || 'no native provider'}; refusing unconfined execution`)
        return provider.confine(command, args, policy)
    }
}

let registry: SandboxRegistry | null = null
export function getSandboxRegistry(): SandboxRegistry {
    if (!registry) {
        registry = new SandboxRegistry()
        registry.register(new BubblewrapSandboxProvider())
        registry.register(new LandlockSandboxProvider())
        registry.register(new SeatbeltSandboxProvider())
    }
    return registry
}
