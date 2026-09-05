import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMissionWorkspaceManager } from './mission-workspace.js'
import { pruneToolResult } from '../memory/tool-result-pruner.js'

export interface CodeRuntimeRequest { language: 'javascript'; code: string; timeoutMs?: number; image?: string }
export interface CodeRuntimeResult { provider: string; exitCode: number; stdout: string; stderr: string; durationMs: number }
export interface CodeRuntimeProvider { name: string; languages: readonly string[]; execute(request: CodeRuntimeRequest): Promise<CodeRuntimeResult> }

export class ContainerCodeRuntimeProvider implements CodeRuntimeProvider {
    readonly name = 'mission-container'
    readonly languages = ['javascript'] as const
    async execute(request: CodeRuntimeRequest): Promise<CodeRuntimeResult> {
        if (Buffer.byteLength(request.code) > 256_000) throw new Error('Code runtime input exceeds 256 KiB')
        const manager = getMissionWorkspaceManager()
        const workspace = await manager.create({ missionId: `code-${randomUUID()}`, mode: 'container', containerImage: request.image || 'node:22-bookworm-slim' })
        try {
            writeFileSync(join(workspace.root, 'main.mjs'), request.code, 'utf8')
            const result = await manager.run(workspace.id, 'node', ['main.mjs'], { timeoutMs: Math.min(120_000, Math.max(100, request.timeoutMs || 30_000)), network: false, cpuLimit: 1, memoryMb: 512 })
            return {
                provider: this.name,
                ...result,
                stdout: String(pruneToolResult(result.stdout, { maxBytes: 32_000 }).value),
                stderr: String(pruneToolResult(result.stderr, { maxBytes: 16_000 }).value),
            }
        } finally {
            await manager.retire(workspace.id).catch(() => undefined)
        }
    }
}

export class CodeRuntime {
    private readonly providers = new Map<string, CodeRuntimeProvider>()
    register(provider: CodeRuntimeProvider): () => void { this.providers.set(provider.name, provider); return () => this.providers.delete(provider.name) }
    list(): Array<{ name: string; languages: readonly string[] }> { return [...this.providers.values()].map(provider => ({ name: provider.name, languages: provider.languages })) }
    async execute(request: CodeRuntimeRequest, providerName = 'mission-container'): Promise<CodeRuntimeResult> {
        const provider = this.providers.get(providerName)
        if (!provider || !provider.languages.includes(request.language)) throw new Error(`Code runtime provider unavailable: ${providerName}/${request.language}`)
        return provider.execute(request)
    }
}

let runtime: CodeRuntime | null = null
export function getCodeRuntime(): CodeRuntime {
    if (!runtime) { runtime = new CodeRuntime(); runtime.register(new ContainerCodeRuntimeProvider()) }
    return runtime
}
