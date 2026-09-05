import { describe, expect, it } from 'vitest'
import { detectDeterministicCommand } from './deterministic-query.js'

describe('natural command routing', () => {
    it.each([
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
    ])('maps %s without an LLM call', (input, command, args, risk) => {
        expect(detectDeterministicCommand(input)).toMatchObject({ command, args, risk })
    })

    it.each([
        'Installiere Codex auf dem Main',
        'Was hältst du von dem Main-Konzept?',
        'Mach dort weiter',
        'Vielleicht sollten wir irgendwann updaten',
        'Kannst du Benchmarks erklären?',
    ])('does not intercept ambiguous conversation: %s', input => {
        expect(detectDeterministicCommand(input)).toBeNull()
    })
})
