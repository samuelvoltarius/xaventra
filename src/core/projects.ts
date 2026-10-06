/**
 * Projekte (2.88 „Projekte und ein Gedächtnis über alle Kanäle").
 *
 * Der Owner sagt im normalen Gespräch „Kümmer dich um X und nebenbei um Y" —
 * ohne Befehl. Xaventra legt daraus Projekte an, arbeitet sie parallel im
 * Hintergrund ab, ordnet spätere Nachrichten (auch aus anderen Kanälen) dem
 * richtigen Projekt zu und meldet Fortschritt und Fragen kurz. „Wie steht's?"
 * zeigt eine kurze Liste aller Projekte. Der Owner verwaltet keine Chats.
 *
 * Bestehendes zuerst: Vor dem Anlegen fragt `findExisting`, ob schon ein
 * Auftrag (Auftrags-Engine), ein offenes Ziel (Goal-Manager) oder eine
 * Verantwortung genau das tut — dann hängt das Projekt nur daran und
 * arbeitet nicht doppelt.
 *
 * Grenzen:
 *   - Nur der Owner im Direktgespräch; Gruppen, Fremde, System-Nachrichten
 *     legen nie Projekte an und sehen keine.
 *   - Hintergrundarbeit läuft über `run` (Unteragent mit sicheren Werkzeugen:
 *     suchen, lesen, rechnen). Wirkungen mit Geld, externem Senden, Physik
 *     oder Löschen schlägt das Projekt nur vor; die laufen weiter über die
 *     normale Aktions-Policy mit Karten.
 *   - Höchstens 3 Projekte gleichzeitig (die Unteragenten-Grenze ist 6),
 *     höchstens 4 Runden je Anstoß, dann Zwischenstand statt Endlosschleife.
 *
 * Zustände: laeuft ──FRAGE──> wartet-auf-dich ──Antwort──> laeuft
 *           laeuft ──FERTIG──> fertig · laeuft ──Runden aus/Fehler──> pausiert ──Nachricht──> laeuft
 *           jede ──„stopp …"──> gestoppt
 *
 * Datei: `<dataDir>/projekte.json` (atomar). Nach einem Neustart laufen
 * offene Projekte mit `resume()` weiter.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { redactSecrets } from '../security/secret-redaction.js'

export type ProjectStatus = 'laeuft' | 'wartet-auf-dich' | 'pausiert' | 'fertig' | 'gestoppt'

export interface ProjectNote { ts: number; channel: string; text: string; consumed?: boolean }

export interface ProjectLink { art: 'auftrag' | 'ziel' | 'verantwortung'; ref: string; titel: string; aktiv: boolean }

export interface Project {
    id: string
    principalId: string
    titel: string
    ziel: string
    status: ProjectStatus
    notizen: ProjectNote[]
    stand: string
    frage?: string
    frageAt?: number
    ergebnis?: string
    runden: number
    verknuepft?: ProjectLink
    /** Raw channel identity that commissioned it (authorization of the background run). */
    auftraggeber?: { channel: string; rawId: string }
    quelleKanal: string
    createdAt: number
    updatedAt: number
}

export interface ProjectRunResult { ok: boolean; text: string }
export type ProjectNoticeKind = 'frage' | 'fertig' | 'stand' | 'fehler'

export interface ProjectPorts {
    run(project: Project, instruction: string, signal: AbortSignal): Promise<ProjectRunResult>
    notify(project: Project, text: string, kind: ProjectNoticeKind): Promise<void>
    findExisting?(goal: string, principalId: string): ProjectLink | null
}

export interface ProjectTurnInput {
    principalId: string
    permission?: string
    isGroup: boolean | null
    systemAuthored: boolean
    channel: string
    text: string
    auftraggeber?: { channel: string; rawId: string }
}

export interface ProjectTurn {
    /** Fully handled: send this and stop. */
    reply?: string
    /** Not handled: add this to the system prompt of the normal answer. */
    hint?: string
}

const OPEN: ReadonlySet<ProjectStatus> = new Set(['laeuft', 'wartet-auf-dich', 'pausiert'])
const MAX_PROJECTS = 60
const MAX_GOALS = 5
const MAX_NOTES = 20
const DONE_RETENTION_MS = 30 * 24 * 60 * 60_000
const LIST_DONE_WINDOW_MS = 3 * 24 * 60 * 60_000
const ANSWER_WINDOW_MS = 30 * 60_000

const STOPWORDS = new Set(`
die der das den dem des ein eine einen einem einer eines und oder aber auch noch bitte mal fuer für mit von vom zum zur bei beim
auf aus nach ueber über unter wie was wer wo wann warum ich du er sie es wir ihr mir dir mich dich uns euch mein meine meinen
meinem meiner dein deine sein seine ihre unser unsere dass weil wenn dann doch schon nicht kein keine nur sehr ganz alle alles
etwas heute morgen gestern jetzt hier dort neue neuen neues neu neuer kuemmer kümmer kuemmere kümmere nebenbei ausserdem außerdem parallel
zusaetzlich zusätzlich übernimm uebernimm projekt projekte machen mach macht soll sollte will wollen kann koennen können muss muessen müssen
haben habe hast hat sind bist ist war wird werden nehmen nehme nimm nehmt gibt geht danke okay ja nein welche welches welcher welchen
diese dieser dieses diesen jetzt gerne gern bitte bis eben gleich lieber einfach also denn sowie stand
`.split(/\s+/).filter(Boolean))

const ENDINGS = ['ungen', 'ung', 'en', 'er', 'es', 'e', 'n', 's']

function stem(word: string): string {
    for (const ending of ENDINGS) {
        if (word.endsWith(ending) && word.length - ending.length >= 4) return word.slice(0, -ending.length)
    }
    return word
}

/** Content words of a text (lower case, stop words removed, crude German stemming). */
export function keywordsOf(text: string): string[] {
    const words = String(text || '').toLowerCase().replace(/ß/g, 'ss').split(/[^a-zäöü0-9]+/)
        .filter(word => word.length >= 4 && !STOPWORDS.has(word))
    return [...new Set(words.map(stem))]
}

const tokensMatch = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))

function overlap(message: string[], project: string[]): number {
    return message.filter(word => project.some(other => tokensMatch(word, other))).length
}

/** Share of the goal's content words found in the other text (0..1). */
export function goalSimilarity(goal: string, other: string): number {
    const words = keywordsOf(goal)
    return words.length ? overlap(words, keywordsOf(other)) / words.length : 0
}

const TRIGGER = /(?:k(?:ü|ue)mmer(?:e|t)?\s+(?:du\s+)?dich|k(?:ü|ue)mmert\s+euch)\s+(?:(?:bitte|mal|doch|auch|noch|selbst|selber)\s+)*um\s+|(?:^|[\s,;.!])(?:(?:ü|ue)bernimm|(?:ü|ue)bernehme)\s+(?:(?:bitte|mal|doch|auch|noch)\s+)*/gi
const PARALLEL_SPLIT = /\s*,?\s*(?:\bund\s+)?\b(?:nebenbei|au(?:ß|ss)erdem|parallel(?:\s+dazu)?|zus(?:ä|ae)tzlich|gleichzeitig)\b\s+(?:(?:auch|noch|bitte)\s+)*(?:um\s+)?|\s+und\s+(?:(?:auch|noch)\s+)*um\s+/i
const TRAILING_NOISE = /[\s,;:.!?]+$|\s*,?\s*\b(?:und|bitte|au(?:ß|ss)erdem|nebenbei|parallel|zus(?:ä|ae)tzlich|gleichzeitig|auch|noch)\s*$/i

function cleanGoal(goal: string): string {
    let value = goal.replace(/\s+/g, ' ').trim()
    for (let i = 0; i < 4; i++) value = value.replace(TRAILING_NOISE, '').trim()
    return value.replace(/^(?:bitte|mal|doch|auch|noch)\s+/i, '').trim()
}

/**
 * Goals in a delegation sentence: „Kümmer dich um X und nebenbei um Y",
 * „Übernimm X, außerdem kümmer dich um Y". Null for ordinary messages.
 */
export function detectProjectRequest(text: string): string[] | null {
    const message = String(text || '').trim()
    if (!message || message.startsWith('/') || message.length > 600) return null
    const starts: Array<{ index: number; end: number }> = []
    for (const match of message.matchAll(TRIGGER)) {
        if (match.index === undefined) continue
        starts.push({ index: match.index, end: match.index + match[0].length })
    }
    if (!starts.length) return null
    const goals: string[] = []
    starts.forEach((start, position) => {
        const segment = message.slice(start.end, starts[position + 1]?.index ?? message.length)
        for (const piece of segment.split(PARALLEL_SPLIT)) {
            const goal = cleanGoal(piece || '')
            if (goal.length >= 3 && /[a-zäöü]/i.test(goal) && keywordsOf(goal).length > 0) goals.push(goal.slice(0, 200))
        }
    })
    const unique = [...new Map(goals.map(goal => [goal.toLowerCase(), goal])).values()]
    return unique.length ? unique.slice(0, MAX_GOALS) : null
}

const STATUS_QUESTION = /^\s*(?:und\s+|na\s+|also\s+)?(?:wie\s+steht(?:'|’)?s|wie\s+steht\s+es|wie\s+weit\s+bist\s+du|stand\s+der\s+dinge|was\s+machen\s+(?:die|meine|unsere)\s+projekte|welche\s+projekte\s+laufen|projektstand|projekt(?:ü|ue)bersicht|meine\s+projekte)/i

export function isProjectStatusQuestion(text: string): boolean {
    const message = String(text || '').trim()
    if (message.length > 80) return false
    const match = STATUS_QUESTION.exec(message)
    if (!match) return false
    const rest = message.slice(match[0].length).replace(/[\s?!.]+/g, ' ').trim()
    return !rest || /projekt|allem|alles|sachen|aufgaben|dingen|deinen|arbeit/i.test(rest)
}

const STOP_REQUEST = /\b(?:stopp(?:e)?|stop|abbrechen|brich\b.*\bab|beende|lass\b.*\bsein|vergiss)\b/i

export function parseRunAnswer(text: string): { art: 'fertig' | 'frage' | 'weiter'; text: string } {
    const value = String(text || '').trim()
    const marker = /^\s*(?:\*\*)?(FERTIG|FRAGE|WEITER)(?:\*\*)?\s*[:\-–]\s*/i.exec(value)
    if (marker) {
        const art = marker[1].toLowerCase() as 'fertig' | 'frage' | 'weiter'
        return { art, text: value.slice(marker[0].length).trim() }
    }
    if (/\?\s*$/.test(value)) return { art: 'frage', text: value }
    return { art: 'fertig', text: value }
}

export function projectTitle(goal: string): string {
    let title = cleanGoal(goal).replace(/^(?:die|der|das|den|dem|ein|eine|einen|einem|mein|meine|meinen|meinem|unser|unsere|unseren)\s+/i, '')
    if (title.length > 48) title = `${title.slice(0, 48).replace(/\s+\S*$/, '')}…`
    return title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Projekt'
}

const projectWords = (project: Project) => keywordsOf(`${project.titel} ${project.ziel} ${project.frage || ''}`)

/** Best matching open project for a later message, or null (no or ambiguous match). */
export function assignMessage(projects: readonly Project[], text: string, _now: number): { project: Project; score: number } | null {
    const words = keywordsOf(text)
    if (!words.length) return null
    const scored = projects.filter(project => OPEN.has(project.status))
        .map(project => ({ project, score: overlap(words, projectWords(project)) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || b.project.updatedAt - a.project.updatedAt)
    if (!scored.length) return null
    if (scored[1] && scored[1].score === scored[0].score) return null
    return scored[0]
}

const short = (text: string, max: number) => {
    const value = redactSecrets(String(text || '')).replace(/\s+/g, ' ').trim()
    return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
    laeuft: 'läuft', 'wartet-auf-dich': 'wartet auf dich', pausiert: 'pausiert', fertig: 'fertig', gestoppt: 'gestoppt',
}

export function formatProjectList(projects: readonly Project[], now: number): string {
    const open = projects.filter(project => OPEN.has(project.status))
    const done = projects.filter(project => project.status === 'fertig' && now - project.updatedAt <= LIST_DONE_WINDOW_MS)
    const shown = [...open, ...done].slice(0, 6)
    const lines = shown.map(project => {
        const detail = project.status === 'wartet-auf-dich' ? project.frage
            : project.status === 'fertig' ? project.ergebnis
                : project.verknuepft?.aktiv ? `läuft als ${project.verknuepft.art === 'auftrag' ? 'Auftrag' : 'Ziel'} „${project.verknuepft.titel}“`
                    : project.stand
        return `• ${project.titel} — ${STATUS_LABEL[project.status]}${detail ? `: ${short(detail, 70)}` : ''}`
    })
    const rest = open.length + done.length - shown.length
    return ['Deine Projekte:', ...lines, ...(rest > 0 ? [`… und ${rest} weitere`] : [])].join('\n')
}

function isShortAnswer(text: string): boolean {
    const value = String(text || '').trim()
    return Boolean(value) && !value.startsWith('/') && !/\?\s*$/.test(value) && value.split(/\s+/).length <= 8
}

export interface ProjectCoordinatorOptions {
    dataDir: string
    ports: ProjectPorts
    now?: () => number
    maxParallel?: number
    maxRunden?: number
}

export class ProjectCoordinator {
    private projects: Project[] = []
    private readonly path: string
    private readonly now: () => number
    private readonly maxParallel: number
    private readonly maxRunden: number
    private readonly running = new Map<string, { promise: Promise<void>; abort: AbortController }>()
    private readonly queue: string[] = []
    private readonly rerun = new Set<string>()

    constructor(private readonly options: ProjectCoordinatorOptions) {
        this.path = join(options.dataDir, 'projekte.json')
        this.now = options.now || Date.now
        this.maxParallel = Math.max(1, options.maxParallel ?? 3)
        this.maxRunden = Math.max(1, options.maxRunden ?? 4)
        this.load()
    }

    private load(): void {
        try {
            if (!existsSync(this.path)) return
            const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
            if (parsed?.version === 1 && Array.isArray(parsed.projects)) {
                this.projects = parsed.projects.filter((item: any) => item && typeof item.id === 'string' && typeof item.principalId === 'string')
            }
        } catch { this.projects = [] }
    }

    private save(): void {
        const now = this.now()
        this.projects = this.projects
            .filter(project => OPEN.has(project.status) || now - project.updatedAt <= DONE_RETENTION_MS)
            .slice(-MAX_PROJECTS)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt: now, projects: this.projects })
    }

    private get(id: string): Project | undefined { return this.projects.find(project => project.id === id) }

    private touch(project: Project, patch: Partial<Project>): void {
        Object.assign(project, patch, { updatedAt: this.now() })
        this.save()
    }

    list(principalId: string): Project[] {
        return this.projects.filter(project => project.principalId === principalId).map(project => JSON.parse(JSON.stringify(project)))
    }

    /** Continue open projects after a restart (only the ones that were running). */
    resume(): void {
        for (const project of this.projects) if (project.status === 'laeuft' && !project.verknuepft?.aktiv) this.kick(project.id)
    }

    /** Resolves when no project run is in flight (tests, shutdown). */
    async idle(): Promise<void> {
        while (this.running.size) await Promise.allSettled([...this.running.values()].map(item => item.promise))
    }

    stopAll(): void {
        for (const item of this.running.values()) item.abort.abort()
        this.queue.length = 0
    }

    async handleTurn(input: ProjectTurnInput): Promise<ProjectTurn> {
        if (input.permission !== 'owner' || input.isGroup !== false || input.systemAuthored) return {}
        const text = String(input.text || '').trim()
        if (!text || text.startsWith('/')) return {}
        const mine = this.projects.filter(project => project.principalId === input.principalId)

        if (isProjectStatusQuestion(text)) {
            const visible = mine.filter(project => OPEN.has(project.status) || (project.status === 'fertig' && this.now() - project.updatedAt <= LIST_DONE_WINDOW_MS))
            return visible.length ? { reply: formatProjectList(visible, this.now()) } : {}
        }

        const goals = detectProjectRequest(text)
        if (goals) return { reply: this.createProjects(input, goals) }

        const open = mine.filter(project => OPEN.has(project.status))
        if (!open.length) return {}
        const match = assignMessage(open, text, this.now())

        if (match && /projekt/i.test(text) && STOP_REQUEST.test(text)) {
            this.stop(match.project)
            return { reply: `Okay, „${match.project.titel}“ ist gestoppt.` }
        }

        const waiting = open.filter(project => project.status === 'wartet-auf-dich')
        const answered = match?.project.status === 'wartet-auf-dich' ? match.project
            : !match && waiting.length === 1 && isShortAnswer(text) && this.now() - (waiting[0].frageAt || 0) <= ANSWER_WINDOW_MS ? waiting[0]
                : null
        if (answered) {
            this.addNote(answered, input.channel, `Antwort auf „${answered.frage || 'deine Frage'}“: ${text}`)
            this.touch(answered, { status: 'laeuft', frage: undefined, frageAt: undefined, runden: 0 })
            this.kick(answered.id)
            return { reply: `Danke! Ich mache mit „${answered.titel}“ weiter.` }
        }

        if (!match) return {}
        const project = match.project
        this.addNote(project, input.channel, text)
        if (project.status === 'pausiert' && !project.verknuepft?.aktiv) {
            this.touch(project, { status: 'laeuft', runden: 0 })
            this.kick(project.id)
        }
        return {
            hint: [
                '## Projekt-Zuordnung',
                `Diese Nachricht gehört zum Projekt „${project.titel}“ (Ziel: ${short(project.ziel, 160)}; Stand: ${short(project.stand || STATUS_LABEL[project.status], 160)}).`,
                'Sie ist im Projekt notiert; die Hintergrundarbeit berücksichtigt sie. Antworte kurz und bestätige das in einem Satz, ohne Befehle zu nennen.',
            ].join('\n'),
        }
    }

    private createProjects(input: ProjectTurnInput, goals: string[]): string {
        const created: Project[] = []
        const already: Project[] = []
        for (const goal of goals) {
            const goalWords = keywordsOf(goal)
            const duplicate = this.projects.find(project => project.principalId === input.principalId && OPEN.has(project.status)
                && goalWords.length > 0 && overlap(goalWords, keywordsOf(project.ziel)) / goalWords.length >= 0.6)
            if (duplicate) { already.push(duplicate); continue }
            let link: ProjectLink | null = null
            try { link = this.options.ports.findExisting?.(goal, input.principalId) || null } catch { link = null }
            const now = this.now()
            const project: Project = {
                id: `p-${randomBytes(4).toString('hex')}`,
                principalId: input.principalId,
                titel: projectTitle(goal),
                ziel: short(goal, 200),
                status: 'laeuft',
                notizen: [],
                stand: link?.aktiv ? `läuft als ${link.art === 'auftrag' ? 'Auftrag' : 'Ziel'} „${link.titel}“` : 'gestartet',
                runden: 0,
                ...(link ? { verknuepft: link } : {}),
                ...(input.auftraggeber ? { auftraggeber: input.auftraggeber } : {}),
                quelleKanal: String(input.channel || '').toLowerCase().slice(0, 40),
                createdAt: now,
                updatedAt: now,
            }
            this.projects.push(project)
            created.push(project)
        }
        this.save()
        for (const project of created) if (!project.verknuepft?.aktiv) this.kick(project.id)

        const label = (project: Project) => project.verknuepft?.aktiv
            ? `${project.titel} (hängt an deinem ${project.verknuepft.art === 'auftrag' ? 'Auftrag' : 'Ziel'} „${project.verknuepft.titel}“)`
            : project.titel
        const lines: string[] = []
        if (created.length === 1 && !already.length) {
            lines.push(`Mach ich. Ich kümmere mich im Hintergrund um „${label(created[0])}“ und melde mich kurz, wenn es Neues gibt oder ich etwas wissen muss.`)
        } else if (created.length) {
            lines.push('Mach ich — ich arbeite parallel an:', ...created.map((project, index) => `${index + 1}. ${label(project)}`))
            lines.push('Ich melde mich kurz, wenn es Neues gibt oder ich etwas wissen muss. „Wie steht’s?“ zeigt dir jederzeit alle Projekte.')
        }
        for (const project of already) lines.push(`„${project.titel}“ läuft schon (${STATUS_LABEL[project.status]}) — ich melde mich, sobald es Neues gibt.`)
        return lines.join('\n')
    }

    private addNote(project: Project, channel: string, text: string): void {
        project.notizen = [...project.notizen, { ts: this.now(), channel: String(channel || '').toLowerCase().slice(0, 40), text: short(text, 400) }].slice(-MAX_NOTES)
        this.touch(project, {})
    }

    private stop(project: Project): void {
        this.running.get(project.id)?.abort.abort()
        const index = this.queue.indexOf(project.id)
        if (index >= 0) this.queue.splice(index, 1)
        this.touch(project, { status: 'gestoppt', frage: undefined })
    }

    private kick(id: string): void {
        if (this.running.has(id)) { this.rerun.add(id); return }
        if (this.running.size >= this.maxParallel) { if (!this.queue.includes(id)) this.queue.push(id); return }
        const abort = new AbortController()
        const promise = Promise.resolve().then(() => this.loop(id, abort.signal)).catch(error => {
            console.warn(`[Projekte] ${id}: ${String(error).slice(0, 160)}`)
        }).finally(() => {
            this.running.delete(id)
            if (this.rerun.delete(id) && this.get(id)?.status === 'laeuft') this.kick(id)
            const next = this.queue.shift()
            if (next) this.kick(next)
        })
        this.running.set(id, { promise, abort })
    }

    private instruction(project: Project, notes: ProjectNote[]): string {
        return [
            'Du arbeitest im Hintergrund an einem Projekt des Owners.',
            `Projekt: ${project.titel}`,
            `Ziel: ${project.ziel}`,
            `Bisheriger Stand: ${project.stand || 'noch nichts'}`,
            ...(notes.length ? ['Neue Hinweise vom Owner:', ...notes.map(note => `- ${note.text}`)] : []),
            'Erledige den nächsten sinnvollen Schritt mit sicheren Werkzeugen (suchen, lesen, rechnen, vergleichen).',
            'Nichts kaufen, nichts versenden, nichts löschen, nichts schalten — so etwas nur als Vorschlag nennen.',
            'Beginne deine Antwort mit genau einem dieser Wörter:',
            'FERTIG: <kurzes Ergebnis> — wenn das Ziel erreicht ist',
            'FRAGE: <eine kurze Frage an den Owner> — wenn du ohne seine Antwort nicht weiterkommst',
            'WEITER: <kurzer Zwischenstand> — wenn noch Arbeit übrig ist',
        ].join('\n')
    }

    private async loop(id: string, signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            const project = this.get(id)
            if (!project || project.status !== 'laeuft' || project.verknuepft?.aktiv) return
            if (project.runden >= this.maxRunden) {
                this.touch(project, { status: 'pausiert' })
                await this.notify(project, `„${project.titel}“: Zwischenstand — ${short(project.stand, 200)}. Schreib mir einfach, wenn ich weitermachen soll.`, 'stand')
                return
            }
            const notes = project.notizen.filter(note => !note.consumed)
            for (const note of notes) note.consumed = true
            this.touch(project, { runden: project.runden + 1 })
            let result: ProjectRunResult
            try {
                result = await this.options.ports.run(JSON.parse(JSON.stringify(project)), this.instruction(project, notes), signal)
            } catch (error) {
                result = { ok: false, text: String(error) }
            }
            const current = this.get(id)
            if (!current || signal.aborted || current.status !== 'laeuft') return
            if (!result.ok) {
                this.touch(current, { status: 'pausiert', stand: `konnte gerade nicht weiterarbeiten (${short(result.text, 80)})` })
                await this.notify(current, `„${current.titel}“ hängt gerade: ${short(result.text, 120)}. Ich versuche es weiter, sobald du mir schreibst.`, 'fehler')
                return
            }
            const answer = parseRunAnswer(result.text)
            if (answer.art === 'frage') {
                this.touch(current, { status: 'wartet-auf-dich', frage: short(answer.text, 240), frageAt: this.now(), stand: current.stand })
                await this.notify(current, `„${current.titel}“ — kurze Frage: ${short(answer.text, 240)}`, 'frage')
                return
            }
            if (answer.art === 'fertig') {
                this.touch(current, { status: 'fertig', ergebnis: short(answer.text, 300), stand: 'fertig', frage: undefined })
                await this.notify(current, `„${current.titel}“ ist fertig: ${short(answer.text, 280)}`, 'fertig')
                return
            }
            this.touch(current, { stand: short(answer.text, 240) })
        }
    }

    private async notify(project: Project, text: string, kind: ProjectNoticeKind): Promise<void> {
        try { await this.options.ports.notify(JSON.parse(JSON.stringify(project)), short(text, 380), kind) } catch { /* reporting is best effort */ }
    }
}