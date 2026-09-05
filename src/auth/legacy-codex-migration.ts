import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

function isLegacyCodexCredential(id: string, credential: any): boolean {
    const provider = String(credential?.provider || '').toLowerCase()
    const key = id.toLowerCase()
    if (['openai-codex', 'openai-cli'].includes(key) || ['openai-codex', 'openai-cli'].includes(provider)) return true
    // The retired /callback bridge stored ChatGPT OAuth as flat "openai".
    return key === 'openai' && typeof credential?.access === 'string' && typeof credential?.refresh === 'string' && !credential?.key
}

/** Remove only Nova-owned legacy Codex copies; never touches any CODEX_HOME. */
export function purgeLegacyCodexCredentialCopies(dataDir = join(process.cwd(), '.nova-data')): { removedFiles: number; removedProfiles: number } {
    let removedFiles = 0
    let removedProfiles = 0
    const dedicated = join(dataDir, 'openai-auth.json')
    if (existsSync(dedicated)) {
        unlinkSync(dedicated)
        removedFiles++
    }

    const authPath = join(dataDir, 'auth.json')
    if (existsSync(authPath)) {
        try {
            const parsed = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, any>
            const profiles = parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : parsed
            for (const [id, credential] of Object.entries(profiles)) {
                if (!isLegacyCodexCredential(id, credential)) continue
                delete profiles[id]
                removedProfiles++
            }
            if (removedProfiles > 0) atomicWriteJsonSync(authPath, parsed)
        } catch {
            // Fail closed: do not rewrite a credential store that cannot be parsed.
        }
    }
    return { removedFiles, removedProfiles }
}
