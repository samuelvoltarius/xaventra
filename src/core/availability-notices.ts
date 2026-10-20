/**
 * 2.89.8 (U5): "nicht erreichbar" only on a state CHANGE, with debounce.
 *
 * Live October: 63 "nicht erreichbar" messages, almost all the same node/service repeating while it stayed down
 * (or flapping). Rules per subject (source + dedupe key):
 *   - first "down" starts a timer; nothing is sent while the outage is shorter than the debounce (flapping, reboot);
 *   - once the outage lasted >= DEBOUNCE_MS the owner is told ONCE; repeats stay silent;
 *   - "wieder erreichbar" is only sent when the outage had been reported; otherwise it silently closes the timer.
 * Notices that are no availability statements pass unchanged. State is persisted so a restart does not
 * re-announce an outage that was already reported.
 */
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'

export const AVAILABILITY_DEBOUNCE_MS = 10 * 60_000
const STALE_MS = 14 * 24 * 60 * 60_000

const UP = /wieder (?:erreichbar|online|verfügbar|da)\b|\bback online\b|\brecovered\b|\bis reachable again\b/i
const DOWN = /nicht erreichbar|\bunreachable\b|\boffline\b|antwortet nicht|ausgefallen|\bis down\b|\bnot reachable\b/i

interface SubjectState { state: 'down' | 'up'; since: number; reported: boolean; touched: number }
type StateFile = { version: 1; subjects: Record<string, SubjectState> }

export interface AvailabilityVerdict { send: boolean; reason: string }

export function classifyAvailability(content: string): 'up' | 'down' | null {
    const text = String(content || '')
    if (UP.test(text)) return 'up'
    if (DOWN.test(text)) return 'down'
    return null
}

function subjectKey(notice: { source: string; dedupeKey?: string; content: string }): string {
    const base = (notice.dedupeKey || notice.content.split(/\r?\n/)[0] || '')
        .toLowerCase()
        .replace(/[:_-](?:down|up|offline|online|unreachable|reachable|recovered|wieder)\w*/g, '')
        .replace(/(?:nicht|wieder)\s+erreichbar|wieder online|\boffline\b|\bonline\b/g, '')
        .replace(/[^a-z0-9äöüß.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    return `${String(notice.source || 'meldung').toLowerCase()}:${base}`
}

export class AvailabilityGate {
    private subjects: Record<string, SubjectState> = {}

    constructor(private readonly path: string | null = null, private readonly now: () => number = Date.now) {
        try {
            if (path && existsSync(path)) {
                const parsed = JSON.parse(readFileSync(path, 'utf8')) as StateFile
                if (parsed?.version === 1 && parsed.subjects && typeof parsed.subjects === 'object') this.subjects = parsed.subjects
            }
        } catch { /* a damaged state only means one more debounce */ }
    }

    judge(notice: { source: string; content: string; dedupeKey?: string }): AvailabilityVerdict {
        const kind = classifyAvailability(notice.content)
        if (!kind) return { send: true, reason: 'keine Erreichbarkeitsmeldung' }
        const now = this.now()
        const key = subjectKey(notice)
        this.prune(now)
        const current = this.subjects[key]
        let verdict: AvailabilityVerdict
        if (kind === 'down') {
            if (!current || current.state === 'up') {
                this.subjects[key] = { state: 'down', since: now, reported: false, touched: now }
                verdict = { send: false, reason: 'Entprellung: Ausfall wird erst nach 10 Minuten gemeldet' }
            } else if (!current.reported && now - current.since >= AVAILABILITY_DEBOUNCE_MS) {
                this.subjects[key] = { ...current, reported: true, touched: now }
                verdict = { send: true, reason: 'Zustandswechsel: Ausfall bestätigt' }
            } else {
                this.subjects[key] = { ...current, touched: now }
                verdict = { send: false, reason: current.reported ? 'Zustand unverändert (schon gemeldet)' : 'Entprellung läuft' }
            }
        } else if (current?.state === 'down') {
            this.subjects[key] = { state: 'up', since: now, reported: false, touched: now }
            verdict = current.reported
                ? { send: true, reason: 'Zustandswechsel: wieder erreichbar' }
                : { send: false, reason: 'kurze Störung, nie gemeldet' }
        } else {
            this.subjects[key] = { state: 'up', since: now, reported: false, touched: now }
            verdict = { send: false, reason: 'Zustand unverändert (erreichbar)' }
        }
        this.persist()
        return verdict
    }

    private prune(now: number): void {
        for (const [key, value] of Object.entries(this.subjects)) if (now - value.touched > STALE_MS) delete this.subjects[key]
    }

    private persist(): void {
        if (!this.path) return
        try { atomicWriteJsonSync(this.path, { version: 1, subjects: this.subjects } satisfies StateFile) } catch { /* state is a convenience */ }
    }
}

let gate: AvailabilityGate | null = null
export function getAvailabilityGate(): AvailabilityGate {
    return gate ||= new AvailabilityGate(getNovaDataDir('notices', 'availability-state.json'))
}
export function setAvailabilityGate(value: AvailabilityGate | null): void { gate = value }
