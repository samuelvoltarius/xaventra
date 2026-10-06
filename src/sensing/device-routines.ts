/**
 * 2.86 Paket N, Punkt 7 — Routinen in Alltagssprache.
 *
 * „Jeden Abend um 23 Uhr alles aus“ wird deterministisch verstanden (feste
 * Muster: Zeit + Raum/Gerät + an/aus; kein Modell). Danach: Vorschau in
 * einem Satz → EIN Ja → ein täglicher Planer-Job (device-switch.ts).
 *
 * Das Ja ist die Freigabe für GENAU diese Routine: gespeichert werden die
 * Ziele (Gerät + Funktion + an/aus) samt Freigabe-Zeitpunkt und
 * Fingerabdruck des Geräts. Jede Ausführung schaltet nur diese Ziele — ein
 * später hinzugekommenes Gerät im selben Raum gehört nicht dazu, ein Gerät mit
 * geänderter Freigabe wird übersprungen und gemeldet. Die Vertrauensleiter
 * bleibt unberührt: physische Arten steigen nie auf, es gibt kein „Immer
 * erlauben“ und keinen Eintrag in trust.json.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
export { parseRoutineSatz, type RoutineSatz } from './device-sentences.js'

export interface RoutineZiel {
    deviceId: string
    functionId: string
    on: boolean
    name: string
    raum?: string
    art: 'licht' | 'schalter'
    /** Freigabe des Geräts zum Zeitpunkt des Ja (geändert → übersprungen). */
    approvedAt: string
    fingerprint: string
}
export interface GeraeteRoutine {
    id: string
    zeit: string
    ziele: RoutineZiel[]
    satz: string
    owner: string
    bestaetigtVon: string
    createdAt: string
    jobId?: string
    status: 'aktiv' | 'beendet'
    beendetAt?: string
}

const file = (dataDir: string) => join(dataDir, 'sensing', 'geraete-routinen.json')

export function ladeRoutinen(dataDir: string): GeraeteRoutine[] {
    try {
        const raw = JSON.parse(readFileSync(file(dataDir), 'utf8'))
        return raw?.version === 1 && Array.isArray(raw.routinen) ? raw.routinen.filter((r: GeraeteRoutine) => r && /^rt-[a-f0-9]{10}$/.test(r.id)) : []
    } catch { return [] }
}

function speichere(dataDir: string, routinen: GeraeteRoutine[]): void {
    mkdirSync(join(dataDir, 'sensing'), { recursive: true, mode: 0o700 })
    const aktiv = routinen.filter(r => r.status === 'aktiv')
    const beendet = routinen.filter(r => r.status !== 'aktiv').slice(-50)
    atomicWriteJsonSync(file(dataDir), { version: 1, routinen: [...aktiv, ...beendet] })
}

export function neueRoutine(dataDir: string, input: Omit<GeraeteRoutine, 'id' | 'status' | 'createdAt'>, now = Date.now()): GeraeteRoutine {
    const routine: GeraeteRoutine = { ...input, id: `rt-${randomBytes(5).toString('hex')}`, status: 'aktiv', createdAt: new Date(now).toISOString() }
    speichere(dataDir, [...ladeRoutinen(dataDir), routine])
    return routine
}

export function aendereRoutine(dataDir: string, id: string, patch: Partial<GeraeteRoutine>): GeraeteRoutine | undefined {
    const all = ladeRoutinen(dataDir)
    const index = all.findIndex(r => r.id === id)
    if (index < 0) return undefined
    all[index] = { ...all[index], ...patch, id: all[index].id }
    speichere(dataDir, all)
    return all[index]
}

export function aktiveRoutinen(dataDir: string): GeraeteRoutine[] {
    return ladeRoutinen(dataDir).filter(r => r.status === 'aktiv')
}
