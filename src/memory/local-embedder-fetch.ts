/**
 * Bezugsprogramm für das eigene Embedding-Modell (2.86, Paket G).
 *
 * Wird nur vom Installationskatalog gestartet (`embedding-gguf:<name>`, über
 * den Host-Agenten als Dienstbenutzer) oder vom Operator von Hand:
 *   node dist/memory/local-embedder-fetch.js install|verify|remove <name>
 * Es kennt nur die fest eingetragenen Dateien (embedding-artifacts.ts): keine
 * URL, kein Pfad und keine Prüfsumme kommen von außen.
 */
import { join } from 'node:path'
import { embeddingModelsDir, findEmbeddingArtifact, installEmbeddingArtifact, removeEmbeddingArtifact, verifyEmbeddingArtifact } from './embedding-artifacts.js'

export async function runEmbeddingFetch(argv: string[]): Promise<number> {
    const [operation, name] = argv
    const artifact = findEmbeddingArtifact(name)
    if (!artifact || !['install', 'verify', 'remove'].includes(operation)) {
        console.error('Aufruf: local-embedder-fetch.js install|verify|remove <eingetragenes Modell>')
        return 2
    }
    try {
        if (operation === 'install') {
            const result = await installEmbeddingArtifact(artifact)
            console.log(`${artifact.name}: ${result.status} (${result.path}, sha256 geprüft)`)
        } else if (operation === 'verify') {
            await verifyEmbeddingArtifact(join(embeddingModelsDir(), artifact.filename), artifact)
            console.log(`${artifact.name}: vorhanden und geprüft`)
        } else {
            await removeEmbeddingArtifact(artifact)
            console.log(`${artifact.name}: entfernt`)
        }
        return 0
    } catch (error) {
        console.error(`${artifact.name}: ${String((error as Error)?.message || error).slice(0, 300)}`)
        return 1
    }
}

const invokedDirectly = (() => {
    try { return /local-embedder-fetch\.(?:js|ts)$/.test(String(process.argv[1] || '')) } catch { return false }
})()
if (invokedDirectly) void runEmbeddingFetch(process.argv.slice(2)).then(code => { process.exitCode = code })
