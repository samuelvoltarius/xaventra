/**
 * 2.89.9 (live): "Wie viel Akku hat der Dolphin?" was answered with "80 % (12,4 V)" in 5.8 s without any tool call.
 * The owner profile only says WHAT the Dolphin is (vehicle, battery via Home Assistant); the number must come from
 * Home Assistant in the same turn.
 *  - profileLiveValuePlan: a live-value question about a profile vehicle/device starts with hass_list (matched on
 *    the entity's name and aliases); its result is the only source of the value.
 *  - guardLiveValueReply: a reply with a value that no successful hass_* result of this turn supports is never delivered
 *    as fact; no matching Home Assistant entity is said honestly in one sentence.
 */
import { liveValueQuestion, type LiveValueQuestion, type OwnerProfile } from '../memory/owner-profile.js'

export interface LiveValueToolExecution { toolName?: string; result?: unknown; success?: boolean }

export function profileLiveValuePlan(input: {
    content: string; permission: string; internal: boolean; hasImage: boolean; constrained: boolean
    tools: readonly { name: string }[]; profile: OwnerProfile | null
}): { question: LiveValueQuestion; calls: Array<{ name: string; arguments: Record<string, unknown> }> } | null {
    if (input.permission !== 'owner' || input.internal || input.hasImage || input.constrained) return null
    const question = liveValueQuestion(input.profile, String(input.content || ''))
    if (!question || !input.tools.some(tool => tool.name === 'hass_list' || (question.binding && tool.name === 'hass_get'))) return null
    // An explicit binding asks exactly that entity; the substring search is only the fallback.
    if (question.binding && input.tools.some(tool => tool.name === 'hass_get')) return { question, calls: [{ name: 'hass_get', arguments: { entity_id: question.binding.entityId } }] }
    return { question, calls: [{ name: 'hass_list', arguments: { match: question.terms.join('|') } }] }
}

const asText = (value: unknown): string => typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) ?? '' } catch { return String(value) } })()
const parse = (value: unknown): any => { if (value && typeof value === 'object') return value; try { return JSON.parse(String(value)) } catch { return null } }
const numbers = (text: string): number[] => (text.replace(/\b\d{1,2}:\d{2}\b/g, ' ').match(/\d+(?:[.,]\d+)?/g) || []).map(item => Number(item.replace(',', '.'))).filter(Number.isFinite)

export const liveValueNoEntity = (name: string) => `In Home Assistant gibt es keine Entität zu „${name}“, deshalb kann ich den aktuellen Wert nicht prüfen.`
export const liveValueUnverified = (name: string) => `Den aktuellen Wert für „${name}“ habe ich nicht aus Home Assistant bestätigt bekommen, deshalb nenne ich keine Zahl. Soll ich es noch einmal abfragen?`

function describe(entities: any[]): string {
    return entities.slice(0, 6).map(entity => {
        const attrs = entity?.attributes || {}
        const unit = attrs.unit_of_measurement ? ` ${attrs.unit_of_measurement}` : ''
        return `${attrs.friendly_name || entity?.entity_id}: ${entity?.state}${unit}`
    }).join('; ')
}

/**
 * 2.92.2 (Abnahme 2.92.0, Akku 13:20): a question that hits the profile's binding has its answer in the one hass_get of
 * the bound entity: a fixed sentence with the value and its time, no model round trip, no other sensor.
 * A stale value says its age. Null while the bound entity has not been read successfully.
 */
export function boundLiveValueAnswer(question: LiveValueQuestion, executions: readonly LiveValueToolExecution[], now = Date.now()): string | null {
    const bound = question.binding?.entityId
    if (!bound) return null
    const entity = evidenceEntities(executions).find(item => item?.entity_id === bound)
    if (!entity || entity.state === undefined) return null
    const age = ageMinutes(entity, now)
    if (age !== null && age > question.maxAgeMinutes) return `Stand vor ${ageText(age)}: ${label(entity)}: ${entity.state}${unitOf(entity)}. Der Wert ist nicht aktuell, Home Assistant hat ihn seit längerem nicht aktualisiert.`
    const stamp = Date.parse(entity.last_updated || entity.last_changed || '')
    const time = Number.isFinite(stamp) ? ` (Stand ${new Date(stamp).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna' })})` : ''
    return `${question.entity.name}: ${entity.state}${unitOf(entity)}${time}, laut Home Assistant.`
}

/** Replacement text when the reply must not stand; null = the reply may be delivered. */
export function ageText(minutes: number): string {
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))} ${Math.round(minutes) === 1 ? 'Minute' : 'Minuten'}`
    if (minutes < 48 * 60) { const h = Math.round(minutes / 60); return `${h} ${h === 1 ? 'Stunde' : 'Stunden'}` }
    const d = Math.round(minutes / 1440); return `${d} Tagen`
}
const ageMinutes = (entity: any, now: number): number | null => {
    const at = Date.parse(entity?.last_updated || entity?.last_changed || '')
    return Number.isFinite(at) ? Math.max(0, (now - at) / 60_000) : null
}
const unitOf = (entity: any) => entity?.attributes?.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : ''
const label = (entity: any) => entity?.attributes?.friendly_name || entity?.entity_id
const cites = (reply: string, entity: any): boolean => {
    const state = String(entity?.state ?? '')
    const n = Number(state.replace(',', '.'))
    if (state && Number.isFinite(n)) return numbers(reply).some(r => r === n || r === Math.round(n))
    const escaped = state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return Boolean(state) && new RegExp(String.raw`(?<![\p{L}\p{N}])` + escaped + String.raw`(?![\p{L}\p{N}])`, 'iu').test(reply)
}
const STATES_AGE = /\bStand vor\b|\bvor \d+\s*(?:Minuten?|Min\.?|Stunden?|Std\.?|Tag(?:en)?|Wochen?)\b|veraltet|nicht aktuell/i

export function guardLiveValueReply(input: { question: LiveValueQuestion; reply: string; executions: readonly LiveValueToolExecution[]; now?: number }): string | null {
    const guarded = guardNumbers(input)
    const base = guarded ?? input.reply
    return staleness(input, base, guarded !== null) ?? guarded
}

function evidenceEntities(executions: readonly LiveValueToolExecution[]): any[] {
    const out: any[] = []
    for (const item of executions) {
        if (!String(item.toolName || '').startsWith('hass_') || item.success === false) continue
        const data = parse(item.result)
        if (item.toolName === 'hass_list' && Array.isArray(data?.entities)) out.push(...data.entities)
        else if (item.toolName === 'hass_get' && data?.entity) out.push(data.entity)
    }
    return out
}

/** A value from an entity older than the threshold is never presented as current; fresher candidates win. */
function staleness(input: { question: LiveValueQuestion; executions: readonly LiveValueToolExecution[]; now?: number }, reply: string, replaced: boolean): string | null {
    const now = input.now ?? Date.now()
    const entities = evidenceEntities(input.executions)
    const max = input.question.maxAgeMinutes
    const aged = entities.map(entity => ({ entity, age: ageMinutes(entity, now) })).filter(item => item.age !== null) as Array<{ entity: any; age: number }>
    const stale = aged.filter(item => item.age > max)
    if (!stale.length) return null
    const fresh = aged.filter(item => item.age <= max)
    const mentionsAge = STATES_AGE.test(reply)
    // 2.89.15 (Abnahme 2.89.14): the list named every stale entity (5220 chars) - three are enough.
    const fold = (value: unknown) => String(value ?? '').toLocaleLowerCase('de-DE').replace(/[_.\-]+/g, ' ')
    const terms = input.question.terms.map(fold).filter(term => term.trim().length >= 3)
    const bound = input.question.binding?.entityId
    const belongs = (entity: any) => entity?.entity_id === bound || terms.some(term => fold(`${label(entity)} ${entity?.entity_id}`).includes(term))
    const note = (items: typeof stale) => items.slice(0, 3).map(item => `„${label(item.entity)}“: Stand vor ${ageText(item.age)}`).join('; ')
        + (items.length > 3 ? `; und ${items.length - 3} weitere` : '')
    if (!fresh.length) {
        // Only stale data: state the age instead of a current value.
        if (mentionsAge && !replaced) return null
        const best = [...stale].sort((a, b) => a.age - b.age)[0]
        return `Stand vor ${ageText(best.age)}: ${label(best.entity)}: ${best.entity.state}${unitOf(best.entity)}. Der Wert ist nicht aktuell, Home Assistant hat ihn seit längerem nicht aktualisiert.`
    }
    const citedStale = stale.filter(item => cites(reply, item.entity) && !fresh.some(f => cites(reply, f.entity)))
    if (citedStale.length) {
        // 2.89.15 (Abnahme 2.89.14, 11:28:04): the freshest entity of ANY kind replaced a stale vehicle range
        // (sensor.pv_surplus_km, "Strom & PV Ueberschuss als Reichweite"). A replacement belongs to the asked
        // entity (profile terms in its name or id) and is of the same kind; otherwise the stale value is named as stale.
        const sameKind = (a: any, b: any) => Boolean((a?.attributes?.unit_of_measurement && a.attributes.unit_of_measurement === b?.attributes?.unit_of_measurement)
            || (a?.attributes?.device_class && a.attributes.device_class === b?.attributes?.device_class))
        const best = fresh.filter(f => belongs(f.entity) && citedStale.some(s => sameKind(f.entity, s.entity))).sort((a, b) => a.age - b.age)[0]
        if (best) return `Aktuell laut Home Assistant: ${label(best.entity)}: ${best.entity.state}${unitOf(best.entity)}. Nicht aktuell ignoriert (${note(stale)}).`
        const old = [...citedStale].sort((a, b) => a.age - b.age)[0]
        return `Stand vor ${ageText(old.age)}: ${label(old.entity)}: ${old.entity.state}${unitOf(old.entity)}. Der Wert ist nicht aktuell, Home Assistant hat ihn seit längerem nicht aktualisiert.`
    }
    // 2.92.2 („wie voll ist das auto?“, „… und 45 weitere“): a reply that states a current value of the asked entity
    // needs no list of old sensors behind it.
    if (fresh.some(item => belongs(item.entity) && cites(reply, item.entity))) return null
    // 2.90.1 (live 29.10. 14:02:28): the hint listed 95 unrelated sensors ("… und 92 weitere") - only the asked entity's.
    const ownStale = stale.filter(item => belongs(item.entity))
    return mentionsAge || !ownStale.length ? null : `${reply}

Hinweis: nicht aktuell und deshalb nicht verwendet (${note(ownStale)}).`
}

function guardNumbers(input: { question: LiveValueQuestion; reply: string; executions: readonly LiveValueToolExecution[]; now?: number }): string | null {
    const name = input.question.entity.name
    const ok = input.executions.filter(item => String(item.toolName || '').startsWith('hass_') && item.success !== false)
    const values = ok.filter(item => item.toolName === 'hass_list' || item.toolName === 'hass_get')
    if (!values.length) return numbers(input.reply).length ? liveValueUnverified(name) : null
    const entities: any[] = []
    let sawList = false
    for (const item of values) {
        const data = parse(item.result)
        if (item.toolName === 'hass_list') { sawList = true; if (Array.isArray(data?.entities)) entities.push(...data.entities) }
        else if (data?.entity) entities.push(data.entity)
    }
    if (sawList && !entities.length && values.every(item => item.toolName === 'hass_list' && (parse(item.result)?.count === 0 || /"count"\s*:\s*0\b/.test(asText(item.result))))) return liveValueNoEntity(name)
    const evidence = numbers(values.map(item => asText(item.result)).join(' '))
    const unsupported = numbers(input.reply).some(n => !evidence.some(e => e === n || Math.round(e) === n || Math.round(e * 10) / 10 === n))
    if (!unsupported) return null
    const now = input.now ?? Date.now()
    const current = entities.filter(entity => { const age = ageMinutes(entity, now); return age === null || age <= input.question.maxAgeMinutes })
    return current.length ? `Laut Home Assistant: ${describe(current)}.` : liveValueUnverified(name)
}
