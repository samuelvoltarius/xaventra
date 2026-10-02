/**
 * Bezugsprogramm für das eigene Embedding-Modell (2.86, Paket G).
 *
 * Wird nur vom Installationskatalog gestartet (`embedding-gguf:<name>`, über
 * den Host-Agenten als Dienstbenutzer) oder vom Operator von Hand:
 *   node dist/memory/local-embedder-fetch.js install|verify|remove <name> [<absoluter Ziel-Ordner>]
 * Es kennt nur die fest eingetragenen Dateien (embedding-artifacts.ts): keine
 * URL und keine Prüfsumme kommen von außen; der Ziel-Ordner kommt aus dem
 * signierten Katalog (`{runtime}/models/embedding`), Standard ist
 * `<Laufzeit-Wurzel>/models/embedding`.
 */
import { join } from 'node:path'
import { embeddingModelsDir, findEmbeddingArtifact, installEmbeddingArtifact, isSafeModelDir, removeEmbeddingArtifact, verifyEmbeddingArtifact } from './embedding-artifacts.js'

export async function runEmbeddingFetch(argv: string[]): Promise<number> {
    const [operation, name, target] = argv
    const artifact = findEmbeddingArtifact(name)
    if (!artifact || !['install', 'verify', 'remove'].includes(operation) || argv.length > 3 || (target !== undefined && !isSafeModelDir(target))) {
        console.error('Aufruf: local-embedder-fetch.js install|verify|remove <eingetragenes Modell> [<absoluter Ziel-Ordner>]')
        return 2
    }
    const dir = target || embeddingModelsDir()
    try {
        if (operation === 'install') {
            const result = await installEmbeddingArtifact(artifact, { dir })
            console.log(`${artifact.name}: ${result.status} (${result.path}, sha256 geprüft)`)
        } else if (operation === 'verify') {
            await verifyEmbeddingArtifact(join(dir, artifact.filename), artifact)
            console.log(`${artifact.name}: vorhanden und geprüft`)
        } else {
            await removeEmbeddingArtifact(artifact, dir)
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
