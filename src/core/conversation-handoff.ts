/**
 * Wer bekommt einen Wortwechsel in seine Kanalwechsel-Übergabe (2.88)?
 *
 * Normalfall: der Principal selbst unter seinem Kanal. Telefon (SIP): der
 * Anruf läuft als `telefon:<nummer>` mit Nutzer-Rechten (eine Rufnummer ist
 * kein Owner-Nachweis). Ist es eine vom Owner eingetragene Owner-Nummer,
 * landet das Gespräch zusätzlich — als „Nummer nicht geprüft" markiert — in
 * der Übergabe des Owners, damit er danach in Telegram weiterreden kann.
 * Umgekehrt bekommt ein Telefonanruf NIE den Owner-Kontext vorgelesen
 * (gefälschte Nummer = fremde Person).
 */
import { getChannelHandoffLog } from '../memory/channel-handoff.js'

export interface HandoffTarget { principalId: string; channel: string; unverified?: boolean }

export async function handoffTargets(input: { channel: string; from: string; principalId: string; isGroup: boolean | null; systemAuthored: boolean }): Promise<HandoffTarget[]> {
    if (input.isGroup !== false || input.systemAuthored || !input.principalId) return []
    const phone = String(input.channel).toLowerCase() === 'desktop' && /^telefon:/i.test(String(input.from))
    const targets: HandoffTarget[] = [{ principalId: input.principalId, channel: phone ? 'telefon' : input.channel }]
    if (!phone) return targets
    try {
        const [{ readTelefonConfig, isOwnerNumber }, { getOwnerAccountRegistry }] = await Promise.all([
            import('../voice/telefon-config.js'), import('../users/owner-accounts.js'),
        ])
        const number = String(input.from).replace(/^telefon:/i, '')
        const owner = getOwnerAccountRegistry().canonical()
        if (owner && owner !== input.principalId && isOwnerNumber(number, readTelefonConfig().ownerNummern)) {
            targets.push({ principalId: owner, channel: 'telefon', unverified: true })
        }
    } catch { /* no phone config: the caller keeps only their own log */ }
    return targets
}

export function recordHandoff(targets: readonly HandoffTarget[], role: 'user' | 'assistant', text: string): void {
    const log = getChannelHandoffLog()
    for (const target of targets) {
        try { log.record(target.principalId, target.channel, role, text, { unverified: role === 'user' && target.unverified }) } catch { /* best effort */ }
    }
}