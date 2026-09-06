/** Stable Doctor artifact identity, independent of Core releases/branding. */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { totalmem } from 'node:os'
import { resolveConfigPath } from '../config/config-path.js'

export interface ModelInfo {
    filename: string; sizeBytes: number; sha256: string; sizeMB: number
    minRamGB: number; quality: number; description: string
}
export const DOCTOR_ARTIFACT_VERSION = 'doctor-gguf-v1'
// Public distribution is an operator/release decision, never a guessed Core tag.
export const DEFAULT_DOCTOR_MIRROR: string | null = null
const artifact = (filename: string, sizeBytes: number, sha256: string, minRamGB: number, quality: number): ModelInfo => ({
    filename, sizeBytes, sha256, minRamGB, quality, sizeMB: Math.round(sizeBytes / 1024 ** 2),
    description: `${filename.replace('nova-doctor-', '').replace('.gguf', '')}; model RAM budget >= ${minRamGB} GiB`,
})
export const MODEL_REGISTRY: readonly ModelInfo[] = [
    artifact('nova-doctor-1.5b-q5km.gguf', 1125049920, '41c4aabebbcd72c66835ed5153d63d0b3e5b30cd6a2bc4ff7a67f5b5fe0f5738', 6, 5),
    artifact('nova-doctor-1.5b-q4km.gguf', 986048064, 'a1568bf0a90ef9fd32aa5366705db117230c41a4367844bd2c31aef0a1c5f332', 4, 4),
    artifact('nova-doctor-1.5b-q2k.gguf', 676304448, '78755fa8d5da257dfeba1ad5b5221752606a60a86c69a299f48c4d278530a133', 3, 2),
    artifact('nova-doctor-0.5b-q5km.gguf', 420085632, '6316fedea4dc76051cc5a20c5a862c6498de0f33c7360f21ebeb70f5c0b6c8ee', 2, 3),
    artifact('nova-doctor-0.5b-q4km.gguf', 397807488, '78354dc2da86cd98c4c550875c605b765d68e0bf0e6ab046770ff773e697c0b0', 1.5, 2),
    artifact('nova-doctor-0.5b-q2k.gguf', 338606976, '18b7c09fca768febf5fc9c76b2d64b4accb73ef102c8e5910ae6854587e6ca93', 0.5, 1),
]
export function getDoctorConfig(): { doctorModel?: string; doctorModelMirror?: string; doctorModelSha256?: string; doctorModelSizeBytes?: number; githubToken?: string } {
    const path = resolveConfigPath()
    if (!existsSync(path)) return {}
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        return value
    } catch { throw new Error('Invalid Doctor configuration; fix runtime configuration before loading/downloading models') }
}
export const getDoctorModelsDir = () => join(process.cwd(), 'models')
export const getDoctorMirror = () => process.env.XAVENTRA_DOCTOR_MODEL_MIRROR || getDoctorConfig().doctorModelMirror || DEFAULT_DOCTOR_MIRROR
export function validateArtifact(model: ModelInfo): void {
    if (basename(model.filename) !== model.filename || !/^[\w.-]+\.gguf$/.test(model.filename)
        || !/^[a-f0-9]{64}$/i.test(model.sha256) || !Number.isSafeInteger(model.sizeBytes) || model.sizeBytes < 4) {
        throw new Error('Doctor artifact requires a safe GGUF filename, exact byte size and pinned SHA-256')
    }
}
/** Cheap inventory is presence/size only, NOT integrity/inference evidence. */
export function isArtifactPresent(model: ModelInfo): boolean {
    try { const s = statSync(join(getDoctorModelsDir(), model.filename)); return s.isFile() && s.size === model.sizeBytes } catch { return false }
}
export function getConfiguredArtifact(): ModelInfo | null {
    const cfg = getDoctorConfig()
    if (!cfg.doctorModel || cfg.doctorModel === 'auto' || cfg.doctorModel === 'off') return null
    const filename = cfg.doctorModel.endsWith('.gguf') ? cfg.doctorModel : `nova-doctor-${cfg.doctorModel}.gguf`
    const known = MODEL_REGISTRY.find(m => m.filename === filename)
    if (known) return known
    const custom = artifact(filename, cfg.doctorModelSizeBytes, cfg.doctorModelSha256 ?? '', 0, 0)
    validateArtifact(custom)
    return custom
}
export function selectBestModel(): ModelInfo | null {
    if (getDoctorConfig().doctorModel === 'off') return null
    const override = getConfiguredArtifact()
    if (override) return override
    return [...MODEL_REGISTRY].filter(m => m.minRamGB <= totalmem() / 1024 ** 3 * 0.4)
        .sort((a, b) => b.quality - a.quality)[0] ?? null
}
export function selectInstalledModel(cpu = false): ModelInfo | null {
    if (getDoctorConfig().doctorModel === 'off') return null
    const override = getConfiguredArtifact()
    // Explicit selection must never silently become a different model.
    if (override) return isArtifactPresent(override) ? override : null
    const candidates = [...MODEL_REGISTRY].filter(m => isArtifactPresent(m) && m.minRamGB <= totalmem() / 1024 ** 3 * 0.4)
        .sort((a, b) => b.quality - a.quality)
    return (cpu ? candidates.find(m => m.filename === 'nova-doctor-0.5b-q5km.gguf') : null) || candidates[0] || null
}
export async function verifyDoctorArtifact(path: string, model: ModelInfo): Promise<void> {
    validateArtifact(model)
    const s = statSync(path)
    if (!s.isFile() || s.size !== model.sizeBytes) throw new Error('Doctor artifact size mismatch')
    const hash = createHash('sha256')
    let prefix = Buffer.alloc(0)
    for await (const chunk of createReadStream(path)) {
        const bytes = Buffer.from(chunk)
        if (prefix.length < 4) prefix = Buffer.concat([prefix, bytes.subarray(0, 4 - prefix.length)])
        hash.update(bytes)
    }
    if (prefix.toString('ascii') !== 'GGUF' || hash.digest('hex') !== model.sha256.toLowerCase()) throw new Error('Doctor artifact SHA-256/GGUF verification failed')
}
