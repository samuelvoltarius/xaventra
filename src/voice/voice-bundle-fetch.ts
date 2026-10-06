/**
 * Bezugsprogramm für den lokalen Sprachdienst (2.86 Paket O).
 *
 * Wird nur vom Installationskatalog gestartet (`sprachdienst:de`, über den
 * Host-Agenten als Dienstbenutzer) oder vom Operator von Hand:
 *   node dist/voice/voice-bundle-fetch.js install|verify|remove de [<absoluter Ziel-Ordner>]
 * Es kennt nur das fest eingetragene Bündel (voice-artifacts.ts): keine URL und
 * keine Prüfsumme kommen von außen.
 */
import { installVoiceBundle, isSafeVoiceDir, removeVoiceBundle, VOICE_BUNDLE, verifyVoiceBundle, voiceBundleDir, type InstallVoiceOptions } from './voice-artifacts.js'

export async function runVoiceBundleFetch(argv: string[], options: Omit<InstallVoiceOptions, 'dir'> = {}): Promise<number> {
    const [operation, name, target] = argv
    if (name !== VOICE_BUNDLE.name || !['install', 'verify', 'remove'].includes(operation) || argv.length > 3 || (target !== undefined && !isSafeVoiceDir(target))) {
        console.error('Aufruf: voice-bundle-fetch.js install|verify|remove de [<absoluter Ziel-Ordner>]')
        return 2
    }
    const dir = target || voiceBundleDir()
    try {
        if (operation === 'install') {
            const result = await installVoiceBundle(VOICE_BUNDLE, { ...options, dir })
            console.log(`Sprachdienst: ${result.status} (${result.dir}, sha256 geprüft)`)
        } else if (operation === 'verify') {
            await verifyVoiceBundle(VOICE_BUNDLE, dir, options.arch)
            console.log('Sprachdienst: vorhanden und geprüft')
        } else {
            await removeVoiceBundle(VOICE_BUNDLE, dir)
            console.log('Sprachdienst: entfernt')
        }
        return 0
    } catch (error) {
        console.error(String((error as Error)?.message || error).slice(0, 300))
        return 1
    }
}

const invokedDirectly = (() => {
    try { return /voice-bundle-fetch\.(?:js|ts)$/.test(String(process.argv[1] || '')) } catch { return false }
})()
if (invokedDirectly) void runVoiceBundleFetch(process.argv.slice(2)).then(code => { process.exitCode = code })
