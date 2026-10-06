/**
 * 2.86 Paket M „Geführt“ — kleiner Zustand der geführten Wege
 * (`<dataDir>/guided/state.json`): übersprungene Einrichtungs-Punkte,
 * schon gezeigte Beispielsätze, Tipp-Tag und die angeheftete Statusnachricht.
 * Keine Geheimnisse, keine Nachrichteninhalte des Owners.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'

export interface GuidedOptions { dataDir?: string; now?: () => number }

export interface OffeneBeispiele {
    key: string; titel: string; saetze: string[]; at: string; gesendet?: boolean
    /** 2.86: own header line (after a device success message „✅ Hue verbunden …“ the „verbunden“ is not repeated). */
    kopf?: string
    /** 2.86: the template type, so the „Verbindungen“ list does not offer the same type a second time. */
    typ?: string
}

export interface GuidedState {
    version: 1
    /** Checklist keys the owner said „Nein danke“ to (they leave the list). */
    uebersprungen: string[]
    /** Connected entries whose example sentences were already prepared. null = never initialised. */
    beispieleGesehen: string[] | null
    /** Example sentences for newly connected entries (newest first). */
    beispieleOffen: OffeneBeispiele[]
    tipp: { tag?: string; id?: string; gezeigt: Record<string, string> }
    angeheftet: Array<{ chatId: string; messageId: number; signatur: string; at: string }>
    /** „Ich komm nicht weiter“: when Claude was last asked (at most once per 6 h). */
    hilfeGefragtAt?: string
}

const empty = (): GuidedState => ({ version: 1, uebersprungen: [], beispieleGesehen: null, beispieleOffen: [], tipp: { gezeigt: {} }, angeheftet: [] })

export const dataDirOf = (opts: GuidedOptions = {}) => opts.dataDir || getNovaDataDir()
export const nowOf = (opts: GuidedOptions = {}) => (opts.now || Date.now)()
const file = (opts: GuidedOptions) => join(dataDirOf(opts), 'guided', 'state.json')
const strings = (value: unknown, max: number): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(-max) : []

export function loadGuidedState(opts: GuidedOptions = {}): GuidedState {
    try {
        const raw = JSON.parse(readFileSync(file(opts), 'utf8'))
        if (raw?.version !== 1) return empty()
        return {
            version: 1,
            uebersprungen: strings(raw.uebersprungen, 200),
            beispieleGesehen: Array.isArray(raw.beispieleGesehen) ? strings(raw.beispieleGesehen, 500) : null,
            beispieleOffen: Array.isArray(raw.beispieleOffen) ? raw.beispieleOffen.filter((item: any) => item && typeof item.key === 'string' && Array.isArray(item.saetze)).slice(0, 10) : [],
            tipp: {
                ...(typeof raw.tipp?.tag === 'string' ? { tag: raw.tipp.tag } : {}),
                ...(typeof raw.tipp?.id === 'string' ? { id: raw.tipp.id } : {}),
                gezeigt: raw.tipp?.gezeigt && typeof raw.tipp.gezeigt === 'object' ? raw.tipp.gezeigt : {},
            },
            angeheftet: Array.isArray(raw.angeheftet) ? raw.angeheftet.filter((item: any) => item && typeof item.chatId === 'string' && typeof item.messageId === 'number').slice(0, 5) : [],
            ...(typeof raw.hilfeGefragtAt === 'string' ? { hilfeGefragtAt: raw.hilfeGefragtAt } : {}),
        }
    } catch { return empty() }
}

export function saveGuidedState(state: GuidedState, opts: GuidedOptions = {}): void {
    mkdirSync(join(dataDirOf(opts), 'guided'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file(opts), state)
}

export function updateGuidedState(patch: (state: GuidedState) => void, opts: GuidedOptions = {}): GuidedState {
    const state = loadGuidedState(opts)
    patch(state)
    saveGuidedState(state, opts)
    return state
}
