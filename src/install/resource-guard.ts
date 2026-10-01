import type { InstallCatalogEntry } from './install-catalog.js'

// Stufe 2 (S2.5): resource guard. Pure decision; probes are injected.

export const MIN_FREE_BYTES = 10 * 1024 ** 3
export const GPU_BUSY_PERCENT = 20

export interface ResourceSnapshot {
    freeBytes: number | null
    /** GPU utilisation in percent; null = unknown (probe failed), undefined = no GPU on this node. */
    gpuUtilization?: number | null
    /** Node only accepts models into a data volume (NAS). */
    modelOnly?: boolean
}

export function requiredFreeBytes(entry: Pick<InstallCatalogEntry, 'sizeMb'>): number {
    return MIN_FREE_BYTES + 2 * entry.sizeMb * 1024 ** 2
}

/** Returns the refusal reason, or null when the installation may start. */
export function resourceRefusal(entry: Pick<InstallCatalogEntry, 'sizeMb' | 'kind'>, snapshot: ResourceSnapshot): string | null {
    if (snapshot.modelOnly && entry.kind !== 'ollama-model') return 'Dieser Knoten nimmt nur Modelle ins Daten-Volume, keine Systempakete.'
    if (snapshot.freeBytes === null || !Number.isFinite(snapshot.freeBytes)) return 'Freier Speicher unbekannt: keine Installation.'
    const need = requiredFreeBytes(entry)
    if (snapshot.freeBytes < need) return `Zu wenig Platz: ${(snapshot.freeBytes / 1024 ** 3).toFixed(1)} GB frei, nötig ${(need / 1024 ** 3).toFixed(1)} GB (10 GB + 2× Größe).`
    if (snapshot.gpuUtilization === null) return 'GPU-Last unbekannt: keine Installation neben vLLM.'
    if (typeof snapshot.gpuUtilization === 'number' && snapshot.gpuUtilization >= GPU_BUSY_PERCENT) return `GPU unter Last (${snapshot.gpuUtilization} %): keine Installation neben vLLM/Training.`
    return null
}
