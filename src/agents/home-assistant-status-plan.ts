/**
 * 2.89.1 (Abnahme „ha-tippfehler“): „homeassit sollte schon laufen“ made the model search the
 * machine with run_command (docker, curl, ports) before it ever asked Home Assistant's own
 * status tool. A plain status statement/question about Home Assistant now starts with
 * hass_status; its answer (connected or not) is the evidence, never a shell search.
 */
const NAMES = /\bhome\s*-?\s*assist\w*|\bhomeassi\w*|\bhomeasi\w*|\bhass\b/i
const STATUS = /\b(?:l(?:ä|ae)uft|laufen|l(?:ä|ae)uf|erreichbar|online|funktioniert|geht|status|verbunden|angebunden|eingerichtet|aktiv|da)\b/i
const ACTION = /\b(?:schalt\w*|mach\w*|stell\w*|dimm\w*|installier\w*|starte\w*|neustart\w*|restart\w*|einricht\w*|verbinde\w*|koppel\w*|l(?:ö|oe)sch\w*|update\w*)\b/i

export function homeAssistantStatusPlan(input: {
    content: string; permission: string; internal: boolean; hasImage: boolean
    constrained: boolean; tools: readonly { name: string }[]
}): Array<{ name: string; arguments: Record<string, unknown> }> | null {
    const text = String(input.content || '').trim()
    if (input.permission !== 'owner' || input.internal || input.hasImage || input.constrained) return null
    if (!text || text.length > 160 || !NAMES.test(text) || !STATUS.test(text) || ACTION.test(text)) return null
    if (!input.tools.some(tool => tool.name === 'hass_status')) return null
    return [{ name: 'hass_status', arguments: {} }]
}

/** After hass_status said „not connected“ these tools would only search the machine for it. */
export const SHELL_SEARCH_TOOLS: ReadonlySet<string> = new Set(['run_command', 'execute_command', 'shell', 'exec_command'])

export const HASS_NOT_CONNECTED_HINT = 'Home Assistant ist in Xaventra nicht verbunden. Sage das ehrlich und nenne den Weg: unter „Verbindungen“ koppeln (Adresse und Zugangstoken). Suche NICHT per Shell oder Netzwerkprobe danach.'
