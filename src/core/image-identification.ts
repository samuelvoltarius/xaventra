/**
 * 2.89.2 (live 08.10.2026): a photo of Ou4 inside Sh2-129 was named "Wischernebel (NGC 6960)"
 * with full certainty - no tool had identified anything, the L12 fact-check had timed out
 * (fail-open) and the local vision model simply guessed. A concrete name for what a picture
 * shows is only a fact when a tool established it (plate solving, ...). Without evidence the
 * reply must say plainly that it is an impression, name that alternatives exist, and how to
 * find out for sure. This guard does NOT depend on L12 - a timed-out fact-check cannot let an
 * unproven identification through.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { HONEST_NO } from '../learning/capability-learning.js'

/** Prompt block for every message that carries a picture (honesty + belonging together). */
export function imageAnswerRulePrompt(): string {
    return '## Bilder deuten (feste Regel)\n'
        + '- Soll ein Bild ein konkretes Objekt benennen (Himmelsobjekt, Pflanze, Tier, Gebäude, Person, Produkt …) und hat KEIN Werkzeug die Identität belegt, '
        + 'formuliere nie als Tatsache: „Sieht für mich aus wie …, sicher bin ich nicht“, nenne mögliche Alternativen und wie man es sicher bestimmt.\n'
        + '- Deute ALLE auffälligen Bildteile gemeinsam, nicht nur das erstbeste: Gehört eine Struktur zu einer anderen (z. B. blaue Bogenschale + rotes Umfeld = zusammengehöriges Paar)? '
        + 'Beschreibe zuerst, was zusammen zu sehen ist, und frage dann, was dazu passt; nenne nie ein einzelnes Objekt, das nur einen Teil erklärt, als die Antwort.'
}

const ASKS_IDENTITY = /\b(was\s+(ist|sind)\s+(das|dies\w*|es)|was\s+(sehe|siehst|zeigt)|welche[rsmn]?\s+\p{L}+\s+(ist|sehe)|wie\s+hei(ß|ss)t|um\s+welche[snm]?\s+\p{L}+|erkenn\w*|identifizier\w*|bestimm\w*|what\s+is\s+(this|that|it)|what\s+am\s+i\s+looking)/iu
const STATES_IDENTITY = /(?:\b(?:das|dies|dieses|es)\s+ist\s+(?:der|die|das|ein|eine|einer)\s+\p{L}|\bes\s+handelt\s+sich\s+(?:hier\s+)?(?:um|bei)|\b(?:zu\s+sehen|abgebildet|dargestellt)\s+ist\s+(?:der|die|das|ein|eine))/iu
const HEDGE = /(sieht\s+(?:für\s+mich\s+)?(?:aus|nach)|vermutlich|wahrscheinlich|könnte|möglicherweise|vielleicht|eventuell|ich\s+vermute|ich\s+schätze|scheint|nicht\s+(?:ganz\s+)?sicher|sicher\s+bin\s+ich\s+nicht|keine\s+gewissheit|unsicher|ungeprüft|nicht\s+belegt)/iu
const ASTRO = /(nebel|galaxie|sternhaufen|sternbild|ngc\s?\d|\bic\s?\d|messier|\bm\s?\d{1,3}\b|\bsh2|\bou\s?\d|supernova|h-?alpha|oiii|himmelsobjekt|milchstra)/iu

export const IMAGE_NOTE = '⚠️ Nicht belegt: Das ist meine Einschätzung nach dem Bildeindruck, kein geprüftes Ergebnis — sicher bin ich nicht, auch ähnliche Objekte kommen in Frage.'

export interface ImageEvidence { identified: boolean; plateSolveMissing: boolean }

/** Evidence for a picture identification from this turn's SUCCESSFUL tool runs. */
export function imageEvidenceFrom(executions: Array<{ toolName?: string; result?: unknown }>): ImageEvidence {
    let identified = false
    let plateSolveMissing = false
    for (const execution of executions) {
        if (execution.toolName !== 'astro_plate_solve') continue
        const text = typeof execution.result === 'string' ? execution.result : JSON.stringify(execution.result ?? '')
        if (/"solved"\s*:\s*true/.test(text)) identified = true
        if (/"solverMissing"\s*:\s*true/.test(text)) plateSolveMissing = true
    }
    return { identified, plateSolveMissing }
}

function howToVerify(astro: boolean): string {
    return astro
        ? 'So bestimmst du es sicher: Plate-Solving (ASTAP oder astrometry.net) liefert die exakten Himmelskoordinaten, die du dann mit SIMBAD oder einem Katalog abgleichst.'
        : 'So bestimmst du es sicher: Rückwärts-Bildsuche, Ort/Aufnahmedatum oder die Quelle des Bildes prüfen, bei Pflanzen und Tieren eine Fachbestimmung.'
}

/** Is a plate solver installed on this node? (ASTAP CLI or astrometry.net solve-field) */
export function plateSolverCommand(env: NodeJS.ProcessEnv = process.env): { kind: 'astap' | 'solve-field'; path: string } | null {
    const exts = process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : ['']
    const fromPath = (base: string): string | null => {
        for (const dir of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
            for (const ext of exts) { const full = join(dir, base + ext); if (existsSync(full)) return full }
        }
        return null
    }
    const explicit = env.NOVA_ASTAP_PATH
    if (explicit && existsSync(explicit)) return { kind: 'astap', path: explicit }
    const astap = fromPath('astap_cli') || fromPath('astap')
    if (astap) return { kind: 'astap', path: astap }
    const solveField = env.NOVA_SOLVE_FIELD_PATH && existsSync(env.NOVA_SOLVE_FIELD_PATH) ? env.NOVA_SOLVE_FIELD_PATH : fromPath('solve-field')
    return solveField ? { kind: 'solve-field', path: solveField } : null
}

/**
 * Reply guard for picture messages. Returns the reply unchanged when it is no unproven
 * identification; otherwise it carries the reservation, the way to certainty and, for sky
 * pictures without an installed solver, the honest learn question.
 */
export const PLATE_SOLVE_TOPIC = 'Plate-Solving von Astrofotos (ASTAP oder astrometry.net)'
const LEARN_LEAD = 'Plate-Solving, das hier sicher bestimmen würde:'

export function guardImageIdentification(input: {
    hasImage: boolean; question: string; reply: string; evidence?: ImageEvidence; solverInstalled?: boolean
}): string {
    const parts = guardImageIdentificationParts(input)
    return parts.learnTail ? `${parts.body}

${LEARN_LEAD} ${parts.learnTail}` : parts.body
}

/** Same guard, with the learn question kept apart (the pipeline turns it into the learn card). */
export function guardImageIdentificationParts(input: {
    hasImage: boolean; question: string; reply: string; evidence?: ImageEvidence; solverInstalled?: boolean
}): { body: string; learnTail?: string; learnLead: string } {
    const { hasImage, question, reply, evidence } = input
    if (!hasImage || !reply || evidence?.identified) return { body: reply, learnLead: LEARN_LEAD }
    const astro = ASTRO.test(reply) || ASTRO.test(question)
    const claimed = STATES_IDENTITY.exec(reply)
    const identityAsked = ASKS_IDENTITY.test(question) || !question.trim()
    const sentence = claimed ? (reply.slice(0, claimed.index).split(/[.!?\n]/).pop() || '') + (reply.slice(claimed.index).split(/[.!?\n]/)[0] || '') : ''
    const hedged = claimed ? HEDGE.test(sentence) || /sicher\s+bin\s+ich\s+nicht|nicht\s+(?:ganz\s+)?sicher/i.test(reply) : true
    let out = reply
    if (claimed && identityAsked && !hedged) out = `${IMAGE_NOTE}\n\n${reply}\n\n${howToVerify(astro)}`
    const solverInstalled = input.solverInstalled ?? plateSolverCommand() !== null
    if (astro && identityAsked && (claimed || evidence?.plateSolveMissing) && !solverInstalled && !/soll\s+ich\s+(es|das)\s+lernen\s*\?/i.test(out)) {
        return { body: out, learnTail: HONEST_NO, learnLead: LEARN_LEAD }
    }
    return { body: out, learnLead: LEARN_LEAD }
}
