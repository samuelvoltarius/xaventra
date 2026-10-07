import { describe, expect, it } from 'vitest'
import { detectDeterministicCommand } from './deterministic-query.js'

describe('natural command routing', () => {
    it.each([
        ['scan doch mal deine docker container', 'docker', 'list', 'read-only'],
        ['Prüfe die Docker-Container lokal', 'docker', 'list', 'read-only'],
        ['Wer bist du?', 'identity', '', 'read-only'],
        ['Was kannst du alles?', 'capabilities', '', 'read-only'],
        ['Welche Rechte habe ich?', 'whoami', '', 'read-only'],
        ['Wo läufst du gerade überall und wer ist Main?', 'nodes', '', 'read-only'],
        ['Welche Nodes sind online?', 'nodes', '', 'read-only'],
        ['Wo läuft vLLM im Mesh?', 'nodes', 'services', 'read-only'],
        ['Codex verbunden?', 'codex', 'status', 'read-only'],
        ['Welche Nova Version ist installiert?', 'update', 'status', 'read-only'],
        ['Zeige die Benutzer', 'users', 'list', 'read-only'],
        ['Was weißt du über mich?', 'memory', 'recall-natural Was weißt du über mich?', 'read-only'],
        ['Wie heißt mein Hund?', 'memory', 'recall-natural Wie heißt mein Hund?', 'read-only'],
        ['Vergiss bitte meinen alten Server.', 'memory', 'forget-natural meinen alten Server', 'controlled-action'],
        ['Zeige dein aktuelles Weltbild von Nova', 'world', '', 'read-only'],
        ['Diagnostiziere Nova auf Fehler', 'doctor', '', 'read-only'],
        ['Erstelle einen Setup Plan', 'setup', 'plan', 'read-only'],
        ['Wie ist der Status der Mission?', 'mission', 'status', 'read-only'],
        ['Pausiere die Mission', 'mission', 'pause', 'controlled-action'],
        ['Setze die Mission weiter fort', 'mission', 'resume', 'controlled-action'],
        ['Starte eine autonome Mission für prüfe alle Nodes', 'mission', 'prüfe alle nodes', 'controlled-action'],
        ['Starte den signierten Mesh Rollout', 'update', 'deploy', 'controlled-action'],
        ['Lass den Doctor sichere Fixes vorbereiten', 'doctor', 'fix', 'controlled-action'],
        ['Starte die 100 Benchmarks', 'benchmark', 'run', 'controlled-action'],
        ['Ist der Failover wirklich bereit?', 'failover', '', 'read-only'],
        ['Konsolidiere dein Gedächtnis', 'memory', 'consolidate', 'controlled-action'],
        // 2.85 Paket D: Werkzeugkasten als normale Frage (kein neuer Slash-Befehl)
        ['Was könntest du noch installieren?', 'software', 'werkzeugkasten', 'read-only'],
        ['Was kannst du noch installieren', 'software', 'werkzeugkasten', 'read-only'],
        ['Welche Programme würden dir helfen?', 'software', 'werkzeugkasten', 'read-only'],
        ['Welche Software fehlt dir noch?', 'software', 'werkzeugkasten', 'read-only'],
        ['Zeig mir deinen Werkzeugkasten', 'software', 'werkzeugkasten', 'read-only'],
    ])('maps %s without an LLM call', (input, command, args, risk) => {
        expect(detectDeterministicCommand(input)).toMatchObject({ command, args, risk })
    })

    it.each([
        'Installiere Codex auf dem Main',
        'Was hältst du von dem Main-Konzept?',
        'Mach dort weiter',
        'Vielleicht sollten wir irgendwann updaten',
        'Kannst du Benchmarks erklären?',
        'Was kannst du alles auf dem Server installieren?',
        'Wer bist du und lösche meine Dateien',
        'scan doch mal deine docker container und stoppe alle',
        'scan die docker container auf ns2',
    ])('does not intercept ambiguous conversation: %s', input => {
        expect(detectDeterministicCommand(input)).toBeNull()
    })
})

describe('2.89: mission actions only for the whole sentence, never negated', () => {
    it.each([
        ['Beende den Auftrag', 'stop'],
        ['Brich die Mission ab', 'stop'],
        ['Stoppe die Mission bitte', 'stop'],
        ['Pausiere den Auftrag', 'pause'],
        ['Führe den Auftrag fort', 'resume'],
    ])('%s → %s', (input, args) => {
        expect(detectDeterministicCommand(input)).toMatchObject({ command: 'mission', args, risk: 'controlled-action' })
    })

    it.each([
        'Brich den Auftrag bitte nicht ab',
        'Beende den Auftrag nicht',
        'Ich will die Mission heute noch nicht beenden',
        'Wann beende ich am besten den Auftrag für die Küche?',
        'Kannst du die Mission später pausieren, wenn der Download fertig ist?',
        'Führe den Auftrag bitte nicht weiter fort',
    ])('no action: %s', input => {
        expect(detectDeterministicCommand(input)?.risk).not.toBe('controlled-action')
    })
})
