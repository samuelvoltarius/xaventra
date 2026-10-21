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
    if (!question || !input.tools.some(tool => tool.name === 'hass_list')) return null
    return { question, calls: [{ name: 'hass_list', arguments: { match: question.terms.join('|') } }] }
}

const asText = (value: unknown): string => typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) ?? '' } catch { return String(value) } })()
const parse = (value: unknown): any => { if (value && typeof value === 'object') return value; try { return JSON.parse(String(value)) } catch { return null } }
const numbers = (text: string): number[] => (text.match(/\d+(?:[.,]\d+)?/g) || []).map(item => Number(item.replace(',', '.'))).filter(Number.isFinite)

export const liveValueNoEntity = (name: string) => `In Home Assistant gibt es keine Entität zu „${name}“, deshalb kann ich den aktuellen Wert nicht prüfen.`
export const liveValueUnverified = (name: string) => `Den aktuellen Wert für „${name}“ habe ich nicht aus Home Assistant bestätigt bekommen, deshalb nenne ich keine Zahl. Soll ich es noch einmal abfragen?`

function describe(entities: any[]): string {
    return entities.slice(0, 6).map(entity => {
        const attrs = entity?.attributes || {}
        const unit = attrs.unit_of_measurement ? ` ${attrs.unit_of_measurement}` : ''
        return `${attrs.friendly_name || entity?.entity_id}: ${entity?.state}${unit}`
    }).join('; ')
}

/** Replacement text when the reply must not stand; null = the reply may be delivered. */
export function guardLiveValueReply(input: { question: LiveValueQuestion; reply: string; executions: readonly LiveValueToolExecution[] }): string | null {
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
    return entities.length ? `Laut Home Assistant: ${describe(entities)}.` : liveValueUnverified(name)
}
