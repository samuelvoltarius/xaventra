/**
 * 2.85 Paket A, Punkt 3 — MCP tools → the one action policy (src/core/action-policy.ts).
 *
 * Capability of a tool, in this order:
 *  1. the checked manifest (`capabilities[tool]`, then `standard_capability`);
 *  2. otherwise the MCP tool annotations (readOnlyHint / destructiveHint);
 *  3. otherwise `unbekannt`.
 * A name that obviously writes, sends, switches or deletes can only RAISE that
 * result (annotations are hints from a server we do not control; a manifest
 * typo must not make `create_event` a read).
 *
 * Mapping (fixed): lesen → `lesen` (L0); schreiben → `verbindung-schreiben`
 * (unknown kind → L2 card); senden → `nachricht-senden` (L2, extern);
 * schalten → `schalten` (L2, physisch); loeschen → `daten-loeschen` (L3,
 * Nie-Liste „Löschen von Daten“ — unchanged, so never a button);
 * unbekannt → `verbindung-unbekannt` (L2). Writing to a cloud connector is
 * additionally an outward effect.
 *
 * Community connectors (Stufe 2) publish only reading tools; a non-reading
 * tool becomes visible only after the owner allowed exactly that tool — and
 * every call of it still asks. 2.88: a directory entry that failed the own
 * check („unbekannt“, registry-vetting.ts) is `streng`: even reads ask.
 *
 * Privacy: a cloud connector never receives private content. The same fixed
 * classifier the model routing uses ("Privates bleibt lokal",
 * src/routing/task-model-routing.ts) checks the outgoing arguments.
 */
import { evaluateAction, type PolicyVerdict } from '../core/action-policy.js'
import { classifyTaskModel } from '../routing/task-model-routing.js'
import type { ConnectorCapability, Datenklasse } from './connector-catalog.js'

export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string }
export interface ConnectorBinding {
    connectorId: string
    trust: 'geprueft' | 'community'
    datenklasse: Datenklasse
    capabilities?: Record<string, ConnectorCapability>
    standard?: ConnectorCapability
    /** Community only: non-reading tools the owner allowed one by one. */
    erlaubteWerkzeuge?: string[]
    /**
     * 2.88: directory entry that failed Xaventra's own check (registry-vetting.ts
     * „unbekannt“, or a new unapproved version): every tool asks, also reads.
     */
    streng?: boolean
}
export type ToolCapability = ConnectorCapability | 'unbekannt'

const RANK: Record<ToolCapability, number> = { lesen: 0, unbekannt: 1, schreiben: 2, senden: 3, schalten: 3, loeschen: 4 }

// Tool names are split into words (`_`, `-`, `.`, `__`, camelCase humps) and compared word by word.
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.\-\s]+/).filter(Boolean)
const set = (list: string) => new Set(list.split('|'))
const NAME_DELETE = set('delete|remove|destroy|purge|wipe|drop|trash|erase|loeschen|löschen|entfernen|unlink|rm')
const NAME_SEND = set('send|reply|forward|publish|post|invite|comment|respond|notify|share|email|mail|tweet|senden')
const NAME_SWITCH = set('turn|toggle|switch|unlock|lock|activate|deactivate|press|trigger|schalten')
const NAME_WRITE = set('create|update|write|edit|move|rename|set|add|insert|upload|merge|push|patch|put|label|unlabel|start|stop|reboot|restart|shutdown|clone|migrate|suspend|resume|rollback|snapshot|install|exec|execute|run|deploy|apply|modify|change|assign|archive|save|import')

function fromName(name: string): ToolCapability | null {
    const list = words(name)
    const has = (wanted: Set<string>) => list.some(word => wanted.has(word))
    if (has(NAME_DELETE)) return 'loeschen'
    if (has(NAME_SEND)) return 'senden'
    // Home Assistant intents (HassTurnOn, intent__HassLightSet …) act in the room.
    if (has(NAME_SWITCH) || list.includes('hass')) return 'schalten'
    if (has(NAME_WRITE)) return 'schreiben'
    return null
}

function fromAnnotations(annotations: ToolAnnotations | undefined): ToolCapability | null {
    if (!annotations || typeof annotations !== 'object') return null
    if (annotations.readOnlyHint === true) return 'lesen'
    if (annotations.readOnlyHint === false || annotations.destructiveHint === true) return 'schreiben'
    return null
}

export function toolCapability(tool: { name: string; annotations?: ToolAnnotations }, binding: ConnectorBinding): ToolCapability {
    const name = String(tool?.name || '')
    const manifest = binding.trust === 'geprueft' ? (binding.capabilities?.[name] ?? binding.standard) : undefined
    let capability: ToolCapability = manifest ?? fromAnnotations(tool.annotations) ?? 'unbekannt'
    const byName = fromName(name)
    if (byName && RANK[byName] > RANK[capability]) capability = byName
    return capability
}

const POLICY_KIND: Record<ToolCapability, string> = {
    lesen: 'lesen', schreiben: 'verbindung-schreiben', senden: 'nachricht-senden', schalten: 'schalten', loeschen: 'daten-loeschen', unbekannt: 'verbindung-unbekannt',
}

export interface ConnectorToolVerdict { capability: ToolCapability; verdict: PolicyVerdict; sichtbar: boolean }

export function connectorToolVerdict(tool: { name: string; annotations?: ToolAnnotations }, binding: ConnectorBinding, options: { localNodeId?: string } = {}): ConnectorToolVerdict {
    const capability = toolCapability(tool, binding)
    const outward = binding.datenklasse === 'cloud' && capability !== 'lesen'
    // „unbekannt“ directory servers: a read is no reason to run on its own (card + nothing local).
    const strict = binding.trust === 'community' && binding.streng === true
    const verdict = evaluateAction({
        kind: POLICY_KIND[strict && capability === 'lesen' ? 'unbekannt' : capability],
        effects: outward ? ['extern:senden'] : [],
        target: `mcp:${binding.connectorId}/${String(tool?.name || '').slice(0, 80)}`,
        origin: 'model',
    }, { localNodeId: options.localNodeId })
    const sichtbar = binding.trust === 'geprueft' || capability === 'lesen' || Boolean(binding.erlaubteWerkzeuge?.includes(tool.name))
    return { capability, verdict, sichtbar }
}

function textOf(value: unknown, depth = 0): string {
    if (depth > 6 || value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return ''
    if (Array.isArray(value)) return value.slice(0, 200).map(item => textOf(item, depth + 1)).join(' ')
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).slice(0, 200).map(item => textOf(item, depth + 1)).join(' ')
    return ''
}

/** Refusal text when private content would leave the house through a cloud connector; null otherwise. */
export function cloudPrivacyRefusal(args: Record<string, unknown>, binding: Pick<ConnectorBinding, 'datenklasse' | 'connectorId'>): string | null {
    if (binding.datenklasse !== 'cloud') return null
    const text = textOf(args).slice(0, 20_000)
    if (!text.trim()) return null
    if (!classifyTaskModel({ content: text }).private) return null
    return `Nicht gesendet: ${binding.connectorId} ist ein Cloud-Dienst und der Aufruf enthält Privates (Regel „Privates nie in die Cloud“).`
}
