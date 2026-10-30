/**
 * 2.89.8 (U4): the owner profile - fixed Tier-0 facts maintained by the owner.
 *
 * Live: CORE_FACTS held contradicting canonical learned facts about the same dog and nothing about the owner
 * himself ("wer bin ich?" -> "Keine passende verifizierte Erinnerung gefunden"). The profile file
 * `<data>/owner-profile.json` (private runtime data, never in the repository; see docs/owner-profile.example.json)
 *   - is injected as Tier-0 into every owner prompt,
 *   - answers "wer bin ich", "wie heißen meine Hunde", "was ist <Alias>" deterministically,
 *   - wins over learned facts about the same entity: contradicting learned memories are marked SUPERSEDED
 *     through memory governance (kept and audited, never deleted),
 *   - can only be changed by the canonical owner (canEditOwnerProfile) or by editing the file.
 */
import { relayQuestionText } from '../core/relay-text.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { GovernedMemory, MemoryGovernanceCoordinator } from './memory-governance.js'

export interface ProfileAttribute { attribute: string; value: string; alsoMatches?: string[] }
export type ProfileFact = string | ProfileAttribute

export interface ProfileEntity {
    name: string
    kind: string
    aliases: string[]
    facts: ProfileFact[]
    /** 2.89.9: explicit Home Assistant binding: attribute ("Akku") -> entity_id; maxAgeMinutes = when a value counts as stale (default 360). */
    ha?: { entities: Record<string, string>; maxAgeMinutes?: number }
}

export interface OwnerProfile {
    version: 1
    owner: { name: string; nicknames: string[]; company?: string; website?: string; birthday?: string; timezone?: string }
    entities: ProfileEntity[]
    rules: string[]
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g
const clip = (value: unknown, max: number) => String(value ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const list = (value: unknown, max: number, length: number) => (Array.isArray(value) ? value : []).map(item => clip(item, length)).filter(Boolean).slice(0, max)

export function profilePath(): string { return getNovaDataDir('owner-profile.json') }

function parseFact(raw: unknown): ProfileFact | null {
    if (typeof raw === 'string') return clip(raw, 200) || null
    if (raw && typeof raw === 'object') {
        const attribute = clip((raw as any).attribute, 60), value = clip((raw as any).value, 160)
        if (!attribute || !value) return null
        const also = list((raw as any).alsoMatches, 10, 40)
        return { attribute, value, ...(also.length ? { alsoMatches: also } : {}) }
    }
    return null
}

function parseHa(raw: any): ProfileEntity['ha'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const entities: Record<string, string> = {}
    const source = raw.entities && typeof raw.entities === 'object' && !Array.isArray(raw.entities) ? raw.entities : {}
    for (const [key, value] of Object.entries(source).slice(0, 20)) {
        const attribute = clip(key, 40), id = clip(value, 120).toLowerCase()
        if (attribute && /^[a-z_]+\.[a-z0-9_]+$/.test(id)) entities[attribute] = id
    }
    const age = Math.round(Number(raw.maxAgeMinutes))
    const maxAgeMinutes = Number.isFinite(age) && age >= 1 && age <= 43_200 ? age : undefined
    if (!Object.keys(entities).length && maxAgeMinutes === undefined) return undefined
    return { entities, ...(maxAgeMinutes !== undefined ? { maxAgeMinutes } : {}) }
}

/** Defensive normalisation of a parsed file; null when it is no usable profile. */
export function normalizeOwnerProfile(raw: any): OwnerProfile | null {
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return null
    const owner = raw.owner && typeof raw.owner === 'object' ? raw.owner : {}
    const name = clip(owner.name, 80)
    const entities: ProfileEntity[] = (Array.isArray(raw.entities) ? raw.entities : []).slice(0, 100).map((item: any) => ({
        name: clip(item?.name, 80), kind: clip(item?.kind, 30).toLowerCase() || 'other',
        aliases: list(item?.aliases, 10, 60),
        facts: (Array.isArray(item?.facts) ? item.facts : []).map(parseFact).filter((fact: ProfileFact | null): fact is ProfileFact => Boolean(fact)).slice(0, 30),
        ...(parseHa(item?.ha) ? { ha: parseHa(item?.ha) } : {}),
    })).filter((entity: ProfileEntity) => entity.name)
    if (!name && entities.length === 0) return null
    return {
        version: 1,
        owner: {
            name, nicknames: list(owner.nicknames, 10, 40),
            ...(clip(owner.company, 120) ? { company: clip(owner.company, 120) } : {}),
            ...(clip(owner.website, 200) ? { website: clip(owner.website, 200) } : {}),
            ...(clip(owner.birthday, 20) ? { birthday: clip(owner.birthday, 20) } : {}),
            ...(clip(owner.timezone, 60) ? { timezone: clip(owner.timezone, 60) } : {}),
        },
        entities, rules: list(raw.rules, 30, 240),
    }
}

let cache: { path: string; mtimeMs: number; size: number; profile: OwnerProfile | null } | null = null

/** Reads (and caches by mtime) the profile; null when absent or unusable. Never throws. */
export function loadOwnerProfile(path = profilePath()): OwnerProfile | null {
    try {
        if (!existsSync(path)) { cache = null; return null }
        const stat = statSync(path)
        if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.profile
        const profile = normalizeOwnerProfile(JSON.parse(readFileSync(path, 'utf8')))
        cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, profile }
        return profile
    } catch { return null }
}

export function _resetOwnerProfileCacheForTest(): void { cache = null; reconciledSignature = '' }

export type OwnerCase = 'nom' | 'akk' | 'dat' | 'gen'
const NEUTRAL_OWNER: Record<OwnerCase, string> = { nom: 'der Owner', akk: 'den Owner', dat: 'dem Owner', gen: 'des Owners' }

/**
 * The one way runtime text names the owner (Datenschutz 2.91): the first name from the
 * owner profile of THIS installation, otherwise a neutral „der Owner“ in the asked case.
 * Never a fixed person's name — another installation must not address its owner as ours.
 */
export function ownerName(kase: OwnerCase = 'nom', profile: OwnerProfile | null | undefined = loadOwnerProfile()): string {
    const first = String(profile?.owner?.name || '').trim().split(/\s+/)[0] || ''
    if (!first) return NEUTRAL_OWNER[kase]
    return kase === 'gen' ? (/[sßxz]$/i.test(first) ? `${first}’` : `${first}s`) : first
}

/** `ownerName` with a capital first letter, for the start of a sentence. */
export function ownerNameAtStart(kase: OwnerCase = 'nom', profile?: OwnerProfile | null): string {
    const name = ownerName(kase, profile === undefined ? loadOwnerProfile() : profile)
    return name.charAt(0).toUpperCase() + name.slice(1)
}

// ---------------------------------------------------------------- text helpers

const norm = (value: string) => String(value || '').toLocaleLowerCase('de-DE').normalize('NFKC').replace(/[?!.,:;"“”„]+/g, ' ').replace(/\s+/g, ' ').trim()
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (term: string) => new RegExp('(?<![\\p{L}\\p{N}])' + escapeRe(term.toLocaleLowerCase('de-DE')) + '(?![\\p{L}\\p{N}])', 'u')

const KIND_LABEL: Record<string, string> = { dog: 'Hund', cat: 'Katze', person: 'Person', device: 'Gerät', vehicle: 'Fahrzeug', place: 'Ort', company: 'Firma', other: 'Eintrag' }
const NOUN_KIND: Array<[RegExp, string, string]> = [
    [/^hunde?$/, 'dog', 'Hunde'], [/^katzen?$/, 'cat', 'Katzen'],
    [/^(?:autos?|fahrzeuge?|wagen)$/, 'vehicle', 'Fahrzeuge'], [/^(?:geräte|geraete|gerät|geraet)$/, 'device', 'Geräte'],
    [/^(?:personen|menschen|freunde?|kinder|kollegen)$/, 'person', 'Personen'], [/^(?:orte?|plätze|plaetze)$/, 'place', 'Orte'],
]

export function formatFact(fact: ProfileFact): string { return typeof fact === 'string' ? fact : `${fact.attribute}: ${fact.value}` }
const describeEntity = (entity: ProfileEntity) => entity.facts.length ? `${entity.name} (${entity.facts.map(formatFact).join('; ')})` : entity.name

export function findProfileEntity(profile: OwnerProfile, term: string): ProfileEntity | null {
    const wanted = norm(term)
    if (!wanted) return null
    return profile.entities.find(entity => [entity.name, ...entity.aliases].some(name => norm(name) === wanted)) || null
}

/** Entities whose name or alias occurs as a whole word in the text. */
export function entitiesMentioned(profile: OwnerProfile, text: string): ProfileEntity[] {
    const value = norm(text)
    return profile.entities.filter(entity => [entity.name, ...entity.aliases].some(name => wordRe(name).test(value)))
}

/** Deterministic answers from the profile; null = not a profile question. */
/** 2.89.13 (live 29.10., Quiet-Hub relay): only the question itself - the first line without a trailing
 * "(Antworte knapp …)" style instruction - is matched against the anchored profile patterns. */
export function profileQuestionPart(input: string): string {
    return relayQuestionText(input).split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/\s*\([^()]*\)\s*$/, '') || ''
}

export function answerProfileQuestion(profile: OwnerProfile, input: string): string | null {
    const text = norm(profileQuestionPart(input))
    if (/^(?:wer bin ich(?: eigentlich| denn| noch)?|wie hei(?:ß|ss)e ich(?: eigentlich| denn| noch)?|weißt du (?:noch )?wer ich bin|weisst du (?:noch )?wer ich bin)$/.test(text)) {
        const { name, nicknames, company, website } = profile.owner
        if (!name) return null
        const nick = nicknames.length ? `, genannt ${nicknames.join(' / ')}` : ''
        const firm = company ? `. Du führst ${company}${website ? ` (${website})` : ''}` : ''
        return `Du bist ${name}${nick}${firm}.`
    }
    const plural = text.match(/^wie hei(?:ß|ss)en meine (\p{L}+)$/u) || text.match(/^wie hei(?:ß|ss)t mein(?:e)? (\p{L}+)$/u)
        || text.match(/^(?:welche|was für|was fuer) (\p{L}+) habe ich$/u)
    if (plural) {
        const noun = NOUN_KIND.find(([re]) => re.test(plural[1]))
        if (noun) {
            const found = profile.entities.filter(entity => entity.kind === noun[1])
            if (found.length === 0) return null
            return `Deine ${noun[2]}: ${found.map(describeEntity).join(', ')}.`
        }
    }
    const what = text.match(/^(?:was|wer) ist (?:mein |meine |der |die |das )?(\p{L}[\p{L}\p{N} -]{0,40})$/u)
    if (what) {
        const entity = findProfileEntity(profile, what[1])
        if (entity) {
            const label = KIND_LABEL[entity.kind] || entity.kind
            return `${entity.name} ist ein ${label}${entity.facts.length ? `: ${entity.facts.map(formatFact).join('; ')}` : ''}.`
        }
    }
    return null
}

/** Tier-0 block for owner prompts. Empty string without a profile. */
export function profileTier0Context(profile: OwnerProfile | null): string {
    if (!profile) return ''
    const lines: string[] = []
    const { name, nicknames, company, website, birthday, timezone } = profile.owner
    if (name) lines.push(`Der Owner heißt ${name}${nicknames.length ? ` (auch: ${nicknames.join(', ')})` : ''}${company ? `, Firma: ${company}` : ''}${website ? `, Website: ${website}` : ''}${birthday ? `, Geburtstag: ${birthday}` : ''}${timezone ? `, Zeitzone: ${timezone}` : ''}.`)
    for (const entity of profile.entities) {
        lines.push(`${entity.name} (${KIND_LABEL[entity.kind] || entity.kind}${entity.aliases.length ? `, auch: ${entity.aliases.join(', ')}` : ''})${entity.facts.length ? `: ${entity.facts.map(formatFact).join('; ')}` : ''}`)
    }
    for (const rule of profile.rules) lines.push(`Regel: ${rule}`)
    if (!lines.length) return ''
    return `## OWNER-PROFIL (vom Owner gepflegt, hat Vorrang vor Gelerntem)\n${lines.map(line => `- ${line}`).join('\n')}`
}

/** Tool ids to offer when the text names a profile device/vehicle (alias "Dolphin" = vehicle -> battery question -> Home Assistant). */
export function profileRouteTools(profile: OwnerProfile | null, text: string): string[] {
    if (!profile) return []
    const mentioned = entitiesMentioned(profile, text).filter(entity => entity.kind === 'vehicle' || entity.kind === 'device')
    return mentioned.length ? ['hass_status', 'hass_list', 'hass_get', 'environment_inventory'] : []
}

/**
 * 2.89.9: a LIVE value (battery, range, temperature, state, open/closed, location) of a vehicle/device in the profile.
 * The profile only knows what the thing is; the number must come from Home Assistant in the same turn.
 */
const LIVE_VALUE_PARTS = [
    String.raw`akku\w*`, String.raw`batterie\w*`, String.raw`ladestand\w*`, String.raw`ladezustand\w*`, 'ladung', 'laden', 'lädt', 'laedt', 'soc', 'wie voll', 'prozent',
    String.raw`reichweite\w*`, String.raw`temperatur\w*`, 'grad', 'status', 'zustand', String.raw`standort\w*`, 'wo (?:steht|ist|parkt)',
    String.raw`(?:ist|sind|steht|war)\b[^?.!]{0,40}\b(?:an|aus|offen|zu|auf|geschlossen|abgeschlossen|zugesperrt|verriegelt|ein|eingeschaltet|ausgeschaltet|angesteckt)`,
]
const LIVE_VALUE = new RegExp(LIVE_VALUE_PARTS.map(part => String.raw`(?<![\p{L}\p{N}])(?:${part})(?![\p{L}\p{N}])`).join('|'), 'iu')

export const DEFAULT_LIVE_MAX_AGE_MINUTES = 360
export interface LiveValueQuestion { entity: ProfileEntity; terms: string[]; binding?: { attribute: string; entityId: string }; maxAgeMinutes: number }

const ATTRIBUTE_GROUPS = [
    /akku|batterie|ladestand|ladezustand|ladung|soc|state of charge|wie voll|prozent/i,
    /reichweite|range/i,
    /temperatur|grad/i,
    /standort|position|wo (?:steht|ist|parkt)/i,
]

/** The explicit Home Assistant entity bound to the attribute the text asks about (same word or same synonym group). */
function boundEntity(entity: ProfileEntity, text: string): { attribute: string; entityId: string } | undefined {
    for (const [attribute, entityId] of Object.entries(entity.ha?.entities || {})) {
        const wanted = norm(attribute)
        if (wordRe(wanted).test(text) || ATTRIBUTE_GROUPS.some(group => group.test(wanted) && group.test(text))) return { attribute, entityId }
    }
    return undefined
}

/** Names/aliases of the vehicle/device the text asks a live value about; null = not such a question. */
export function liveValueQuestion(profile: OwnerProfile | null, text: string): LiveValueQuestion | null {
    if (!profile) return null
    const value = norm(text)
    if (!value || value.length > 240 || !LIVE_VALUE.test(value)) return null
    const entity = entitiesMentioned(profile, value).find(item => item.kind === 'vehicle' || item.kind === 'device')
    if (!entity) return null
    const binding = boundEntity(entity, value)
    return { entity, terms: [entity.name, ...entity.aliases].filter(Boolean), ...(binding ? { binding } : {}), maxAgeMinutes: entity.ha?.maxAgeMinutes ?? DEFAULT_LIVE_MAX_AGE_MINUTES }
}

// ---------------------------------------------------------------- precedence over learned facts

const LIVE = new Set(['candidate', 'verified', 'canonical'])

/** Learned memory that contradicts a structured profile fact about the same entity. */
export function contradictsProfile(profile: OwnerProfile, content: string): { entity: ProfileEntity; fact: ProfileAttribute } | null {
    const text = norm(content)
    for (const entity of profile.entities) {
        if (![entity.name, ...entity.aliases].some(name => wordRe(name).test(text))) continue
        for (const fact of entity.facts) {
            if (typeof fact === 'string') continue
            const terms = [fact.attribute, ...(fact.alsoMatches || [])].map(norm).filter(Boolean)
            if (terms.some(term => text.includes(term)) && !text.includes(norm(fact.value))) return { entity, fact }
            if (breedContradicts(entity, fact, content)) return { entity, fact }
        }
    }
    return null
}

/** Common dog and cat breeds (lower case, hyphens as spaces); only used against a profile "Rasse". */
const BREEDS = [
    'labrador', 'retriever', 'golden retriever', 'schäferhund', 'beagle', 'pudel', 'dackel', 'collie', 'border collie',
    'husky', 'boxer', 'dobermann', 'rottweiler', 'chihuahua', 'mops', 'terrier', 'jack russell', 'yorkshire', 'spitz',
    'malteser', 'havaneser', 'bulldogge', 'australian shepherd', 'aussie', 'sennenhund', 'dalmatiner', 'windhund',
    'greyhound', 'whippet', 'spaniel', 'setter', 'weimaraner', 'vizsla', 'shih tzu', 'labradoodle', 'goldendoodle',
    'malinois', 'akita', 'shiba', 'samojede', 'neufundländer', 'bernhardiner', 'dogge', 'ridgeback', 'podenco', 'galgo',
    'pinscher', 'schnauzer', 'mischling',
    'perser', 'maine coon', 'siam', 'bengal', 'britisch kurzhaar', 'kartäuser', 'ragdoll', 'sphynx', 'waldkatze',
]
const fold = (value: string) => norm(value).replace(/-/g, ' ')
const BREED_SUFFIX = '(?: ?(?:katze|kater|hund|hündin|rüde|mix|welpe))?'

/**
 * 2.90.1: "Luna ist ein Labrador" contradicts the profile's "Rasse: Collie" without the word "Rasse". Only an
 * is-a statement about the same animal in one sentence counts ("<Name> ist ein [bis zu drei Wörter] <Rasse>"),
 * so a colour ("ein grauer Hund") or another dog mentioned in passing is never one; a breed that is part of the
 * profile value (Labrador → "Labrador-Mischling") neither.
 */
function breedContradicts(entity: ProfileEntity, fact: ProfileAttribute, content: string): boolean {
    if (norm(fact.attribute) !== 'rasse') return false
    const value = fold(fact.value)
    const sentences = String(content || '').split(/[.!?\n]+/).map(fold).filter(Boolean)
    const names = [entity.name, ...entity.aliases].map(fold).filter(Boolean).map(escapeRe).join('|')
    for (const breed of BREEDS) {
        // A breed inside the profile value or around it is a refinement (Collie / Border Collie), not a contradiction.
        if (value.includes(breed) || breed.includes(value)) continue
        const isA = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names}) (?:ist|war) (?:ein |eine )?(?:[\\p{L}]+ ){0,3}?${escapeRe(breed)}${BREED_SUFFIX}(?![\\p{L}\\p{N}])`, 'u')
        if (sentences.some(sentence => isA.test(sentence))) return true
    }
    return false
}

let reconciledSignature = ''

/**
 * Marks learned memories that contradict the profile as superseded (kept + audited, never deleted).
 * Idempotent; skips when neither profile nor memory changed since the last pass unless forced.
 */
export function reconcileProfileWithMemory(profile: OwnerProfile | null, governance: MemoryGovernanceCoordinator, scopes: string[], force = false): number {
    if (!profile || profile.entities.length === 0) return 0
    const live = governance.list().filter(record => scopes.includes(record.scope) && LIVE.has(record.status))
    const signature = `${JSON.stringify(profile.entities)}|${live.map(record => record.id).join(',')}`
    if (!force && signature === reconciledSignature) return 0
    let superseded = 0
    for (const record of live) {
        if (record.provenance.some(item => item.source.startsWith('owner-profile'))) continue
        const conflict = contradictsProfile(profile, record.content)
        if (!conflict) continue
        if (governance.supersede(record.id, `owner-profile:${conflict.entity.name}`)) superseded++
    }
    reconciledSignature = signature
    return superseded
}

// ---------------------------------------------------------------- contradiction guard (no profile entry)

const IS_A = /^(\p{Lu}[\p{L}-]{2,30}) (?:ist|is) (?:ein |eine |der |die |das |a |an )?(.{3,80})$/u

/** Two live learned facts about the same capitalised subject that state different things after "ist". */
export function findLearnedContradictions(records: ReadonlyArray<Pick<GovernedMemory, 'content' | 'status'>>): Array<{ subject: string; statements: string[] }> {
    const bySubject = new Map<string, Map<string, string>>()
    for (const record of records) {
        if (!LIVE.has(record.status)) continue
        const match = IS_A.exec(record.content.trim().replace(/[.!]+$/, ''))
        if (!match) continue
        const subject = match[1], predicate = norm(match[2])
        const statements = bySubject.get(subject) || new Map<string, string>()
        if (!statements.has(predicate)) statements.set(predicate, record.content.trim())
        bySubject.set(subject, statements)
    }
    return [...bySubject].filter(([, statements]) => statements.size > 1).map(([subject, statements]) => ({ subject, statements: [...statements.values()] }))
}

export function formatContradictionQuestion(conflicts: Array<{ subject: string; statements: string[] }>): string {
    const first = conflicts[0]
    return `Zu ${first.subject} habe ich widersprüchliche Angaben gespeichert: ${first.statements.map(item => `„${item}“`).join(' / ')}. Welche stimmt? Ich merke mir deine Antwort.`
}

// ---------------------------------------------------------------- owner-only writes

export interface ProfileActor { permission?: string; channel?: string; principalId?: string }

/** Only the canonical owner on an owner channel; never guests, bots, probes or REST. */
export function canEditOwnerProfile(actor: ProfileActor, canonicalOwner: string | null): { ok: boolean; reason?: string } {
    if (actor.permission !== 'owner') return { ok: false, reason: 'Nur der Owner darf das Profil ändern.' }
    const channel = String(actor.channel || '').toLowerCase()
    if (channel.includes('rest') || channel.startsWith('probe')) return { ok: false, reason: 'Über diesen Kanal darf das Profil nicht geändert werden.' }
    if (!canonicalOwner || actor.principalId !== canonicalOwner) return { ok: false, reason: 'Dieser Zugang ist nicht der bestätigte Owner.' }
    return { ok: true }
}

export type ProfileMutation =
    | { action: 'set_owner'; name?: string; nicknames?: string[]; company?: string; website?: string; birthday?: string; timezone?: string }
    | { action: 'add_entity'; name: string; kind: string; aliases?: string[]; facts?: ProfileFact[] }
    | { action: 'add_fact'; entity: string; fact: ProfileFact }
    | { action: 'add_rule'; rule: string }

export function applyProfileMutation(current: OwnerProfile | null, mutation: ProfileMutation): OwnerProfile | null {
    const base: OwnerProfile = current ? JSON.parse(JSON.stringify(current)) : { version: 1, owner: { name: '', nicknames: [] }, entities: [], rules: [] }
    if (mutation.action === 'set_owner') {
        const { action: _action, ...rest } = mutation
        base.owner = { ...base.owner, ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) } as OwnerProfile['owner']
    } else if (mutation.action === 'add_entity') {
        const existing = findProfileEntity(base, mutation.name)
        if (existing) { existing.aliases = [...new Set([...existing.aliases, ...(mutation.aliases || [])])]; existing.facts.push(...(mutation.facts || [])) }
        else base.entities.push({ name: mutation.name, kind: mutation.kind || 'other', aliases: mutation.aliases || [], facts: mutation.facts || [] })
    } else if (mutation.action === 'add_fact') {
        const entity = findProfileEntity(base, mutation.entity)
        if (!entity) return null
        entity.facts.push(mutation.fact)
    } else if (mutation.action === 'add_rule') {
        base.rules.push(mutation.rule)
    }
    return normalizeOwnerProfile(base)
}

export function writeOwnerProfile(profile: OwnerProfile, path = profilePath()): void {
    atomicWriteJsonSync(path, profile)
    cache = null
}
