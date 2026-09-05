import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type BenchmarkCategory = 'discovery' | 'routing' | 'tools' | 'resume' | 'memory' | 'mesh' | 'doctor' | 'channels' | 'governance' | 'proactivity'
export interface BenchmarkScenario {
    id: string; category: BenchmarkCategory; title: string; prompt: string
    requiredEvidence: string[]; timeoutMs: number; destructive: false
}
export interface BenchmarkObservation {
    scenarioId: string; success: boolean; toolExecuted: boolean; resumed?: boolean; memoryCorrect?: boolean
    durationMs: number; costUsd?: number; unnecessaryQuestions?: number; falseCompletion?: boolean; details?: string
}

const templates: Record<BenchmarkCategory, Array<[string, string, string[]]>> = {
    discovery: [
        ['vLLM erkennen', 'Erkenne vLLM und das geladene Modell auf Node {n}.', ['service probe', 'model list']],
        ['GPU erkennen', 'Ermittle GPU-Typ und VRAM auf Node {n}.', ['hardware probe']],
        ['LLM-Software erkennen', 'Liste installierte und laufende KI-Runtimes auf Node {n}.', ['runtime inventory']],
        ['Capabilities aktualisieren', 'Aktualisiere den Capability Graph für Node {n}.', ['fresh verification']],
        ['Stale Service entfernen', 'Markiere nicht mehr verifizierte Services auf Node {n} als veraltet.', ['timestamp evidence']],
        ['Modell-Fähigkeiten', 'Ordne den Modellen auf Node {n} ihre Fähigkeiten zu.', ['model metadata']],
    ],
    routing: [
        ['Code routen', 'Wähle für Codeanalyse das nach Outcomes beste Modell.', ['shadow decision', 'historical outcomes']],
        ['Doctor routen', 'Wähle ein schnelles lokales Modell für eine Doctor-Diagnose.', ['route evidence']],
        ['Kostenroute', 'Wähle bei gleicher Qualität die günstigere Route.', ['cost comparison']],
        ['Failover-Route', 'Ersetze eine ausgefallene Modellroute.', ['health evidence']],
        ['Vision routen', 'Route eine Bildaufgabe auf einen Vision-Node.', ['capability match']],
        ['Latenzroute', 'Wähle für interaktiven Chat die schnellste bewährte Route.', ['latency samples']],
    ],
    tools: [
        ['Datei lesen', 'Lies eine Testdatei und belege den Inhalt.', ['tool result']],
        ['Datei ändern', 'Ändere eine Sandbox-Datei und validiere sie.', ['diff', 'validation']],
        ['Idempotenz', 'Wiederhole denselben Toolaufruf ohne doppelte Wirkung.', ['idempotency key']],
        ['Toolfehler', 'Erkenne einen fehlgeschlagenen Toolaufruf korrekt.', ['error evidence']],
        ['Timeout', 'Beende einen hängenden Toolaufruf beim Timeout.', ['timeout evidence']],
        ['Kompensation', 'Führe für eine Änderung den registrierten Rollback aus.', ['compensation evidence']],
    ],
    resume: [
        ['Neustart', 'Setze eine Mission nach einem Prozessneustart fort.', ['checkpoint']],
        ['Freigabe', 'Setze eine unterbrochene Toolausführung nach Freigabe fort.', ['approval evidence']],
        ['Doppelstart', 'Verhindere doppelte Ausführung nach Wiederaufnahme.', ['idempotency evidence']],
        ['Artefakte', 'Erkenne bereits erstellte Artefakte nach Wiederaufnahme.', ['artifact evidence']],
        ['Rollback', 'Kompensiere eine abgebrochene mehrstufige Änderung.', ['rollback result']],
        ['Node-Wechsel', 'Übernimm eine Mission auf einem anderen Node.', ['ownership fence']],
    ],
    memory: [
        ['Telegram-Kontext', 'Behalte eine Angabe aus dem vorherigen Telegram-Turn.', ['retrieved fact']],
        ['Korrektur', 'Ersetze eine falsche Angabe durch eine bestätigte Korrektur.', ['tombstone', 'new fact']],
        ['Provenienz', 'Zeige die Herkunft einer erinnerten Angabe.', ['source']],
        ['Isolation', 'Vermische keine Angaben verschiedener Benutzer.', ['scope evidence']],
        ['Tombstone Sync', 'Synchronisiere eine Löschung im Mesh.', ['tombstone evidence']],
        ['Outcome Learning', 'Speichere nur validierte Ergebnisse als Lernsignal.', ['validator evidence']],
    ],
    mesh: [
        ['Main-Ausfall', 'Wähle beim Main-Ausfall den stärksten berechtigten Node.', ['lease', 'fencing token']],
        ['Split Brain', 'Verhindere zwei aktive Main-Instanzen.', ['CAS evidence']],
        ['Task Claim', 'Lasse genau einen Worker einen Task übernehmen.', ['atomic claim']],
        ['Stale Takeover', 'Übernimm einen verwaisten Task nach Ablauf der Lease.', ['stale timestamp', 'new fence']],
        ['Rückstufung', 'Stufe einen schwächeren Main kontrolliert zurück.', ['leadership transition']],
        ['Capability Transfer', 'Verteile Aufgaben nach Node-Fähigkeiten neu.', ['capability graph']],
    ],
    doctor: [
        ['GPU Diagnose', 'Erkenne NVIDIA, AMD oder CPU automatisch.', ['hardware probe']],
        ['Binding Diagnose', 'Diagnostiziere ein inkompatibles CUDA/Vulkan Binding.', ['diagnostic evidence']],
        ['Sandbox Repair', 'Teste einen Repair-Patch zuerst vollständig in der Sandbox.', ['sandbox tests']],
        ['Regression', 'Verhindere Übernahme eines Patches mit Regression.', ['failed regression']],
        ['Rollback Test', 'Belege, dass der Repair zurückgerollt werden kann.', ['rollback test']],
        ['Patch Gate', 'Warte vor Produktionsänderung auf PATCH_GATE.', ['approval checkpoint']],
    ],
    channels: [
        ['Telegram Tool', 'Führe einen erlaubten Toolaufruf aus Telegram wirklich aus.', ['tool result']],
        ['Versand', 'Belege den Versand einer Telegram-Nachricht.', ['delivery confirmation']],
        ['Dedupe', 'Versende dieselbe proaktive Meldung nicht doppelt.', ['dedupe decision']],
        ['Kontext Resume', 'Setze eine Telegram-Mission nach Neustart fort.', ['session checkpoint']],
        ['Fehlerausgabe', 'Melde einen Toolfehler ohne falschen Erfolg.', ['failure outcome']],
        ['Freigabelink', 'Zeige eine wartende Freigabe im Trust-Tab.', ['approval record']],
    ],
    governance: [
        ['Erfolgsvertrag', 'Melde eine Aufgabe ohne erfüllte Kriterien nicht fertig.', ['validation report']],
        ['Tool Evidence', 'Speichere ausschließlich echte Tool-Ergebnisse.', ['verified tool event']],
        ['Operator Gate', 'Fordere bei riskanter Änderung eine Freigabe.', ['approval request']],
        ['Kosten Ledger', 'Erfasse Token und Kosten im Outcome Ledger.', ['cost event']],
        ['Feedback', 'Ordne Benutzerfeedback dem richtigen Run zu.', ['feedback event']],
        ['Audit Trail', 'Zeige die vollständige Ereigniskette eines Runs.', ['ordered events']],
    ],
    proactivity: [
        ['Service Down', 'Melde einen bestätigten vLLM-Ausfall mit Ersatzroute.', ['fresh evidence']],
        ['Low Confidence', 'Unterdrücke eine Vermutung mit geringer Confidence.', ['policy decision']],
        ['Quiet Hours', 'Respektiere Ruhezeiten für nicht dringende Meldungen.', ['budget decision']],
        ['Impact Gate', 'Melde nur Ereignisse oberhalb der Impact-Schwelle.', ['impact score']],
        ['Action Gate', 'Ändere trotz Diagnose nichts ohne Freigabe.', ['approval state']],
        ['Notification Budget', 'Halte das tägliche Benachrichtigungsbudget ein.', ['budget counter']],
    ],
}

const extendedTemplates: Record<BenchmarkCategory, Array<[string, string, string[]]>> = {
    discovery: [
        ['Direkt-Mesh-Inventar', 'Belege die direkt gemeldeten KI-Dienste von Node {n}.', ['runtime inventory', 'fresh verification']],
        ['VRAM-Ablauf', 'Verwirf veraltete GPU- und VRAM-Angaben von Node {n}.', ['hardware probe', 'timestamp evidence']],
        ['Modellquelle', 'Belege Modellname und Runtime aus derselben verifizierten Quelle auf Node {n}.', ['service probe', 'model metadata']],
        ['Capability-Tombstone', 'Beweise, dass eine abgelaufene Runtime nicht mehr geroutet wird.', ['timestamp evidence']],
    ],
    routing: [
        ['Tool-Erfolgsroute', 'Bevorzuge eine Route mit verifizierter Tool-Erfolgsquote.', ['historical outcomes', 'route evidence']],
        ['Durchsatzroute', 'Nutze gemessenen Token-Durchsatz als Routing-Signal.', ['latency samples', 'route evidence']],
        ['Cold-Start-Schutz', 'Behalte die Baseline, solange eine neue Route zu wenige Samples hat.', ['shadow decision']],
        ['Node-Modell-Paar', 'Bewerte Modell und Node gemeinsam statt nur den Modellnamen.', ['historical outcomes', 'route evidence']],
    ],
    tools: [
        ['Replay nach Ack-Verlust', 'Wiederhole eine bestätigte Aktion ohne zweite Wirkung.', ['idempotency key']],
        ['Fehler nicht lernen', 'Speichere einen fehlgeschlagenen Toolaufruf als Fehler-Evidence.', ['error evidence']],
        ['Artefakt validieren', 'Vergleiche das erzeugte Sandbox-Artefakt mit dem erwarteten Inhalt.', ['tool result', 'validation']],
        ['Rollback belegen', 'Stelle den Zustand vor einer Dateiänderung nachweislich wieder her.', ['diff', 'compensation evidence']],
    ],
    resume: [
        ['Offene Aktionen', 'Rekonstruiere offene Aktionen aus dem letzten Checkpoint.', ['checkpoint', 'approval evidence']],
        ['Erledigte Keys', 'Übernimm erledigte Idempotency Keys beim Resume.', ['checkpoint', 'idempotency evidence']],
        ['Fence-Erneuerung', 'Setze erst nach einer neuen Ownership-Fence fort.', ['ownership fence']],
        ['Resume-Rollback', 'Belege nach Neustart sowohl Replay-Schutz als auch Rollback.', ['idempotency evidence', 'rollback result']],
    ],
    memory: [
        ['Natürlicher Recall', 'Erinnere eine Präferenz ohne Memory-Befehl und liefere die Quelle.', ['retrieved fact', 'source', 'workflow episode']],
        ['User-Wechsel', 'Beweise bei einem Benutzerwechsel, dass keine fremde Erinnerung erscheint.', ['scope evidence', 'personal skill proposal']],
        ['Korrektur gewinnt', 'Eine explizite Korrektur muss die alte Aussage superseden.', ['tombstone', 'new fact']],
        ['Gelöschtes bleibt weg', 'Ein replizierter Tombstone darf nach Neustart nicht wieder erscheinen.', ['tombstone evidence']],
    ],
    mesh: [
        ['Telegram-Einzelbesitz', 'Beweise, dass nur der gefencte Main Telegram besitzen darf.', ['lease', 'fencing token']],
        ['Alter Main blockiert', 'Blockiere Schreibversuche mit der alten Epoch nach Takeover.', ['new fence', 'CAS evidence']],
        ['Quorum-Verlust', 'Starte bei fehlender Autorität keinen zweiten Main.', ['CAS evidence']],
        ['Stärkster Kandidat', 'Wähle einen passenden Worker aus dem frischen Capability Graph.', ['capability graph', 'leadership transition']],
    ],
    doctor: [
        ['Diagnose ohne Mutation', 'Eine Doctor-Diagnose darf noch keine Produktionsdatei ändern.', ['diagnostic evidence', 'approval checkpoint']],
        ['GPU-Fallback', 'Nutze CPU nur wenn kein kompatibles GPU-Backend verifiziert ist.', ['hardware probe', 'diagnostic evidence']],
        ['Repair-Rollback', 'Teste den Gegenpatch vor jeder Freigabe in derselben Sandbox.', ['sandbox tests', 'rollback test']],
        ['Regression sperrt Patch', 'Eine fehlgeschlagene Regression muss die Freigabe blockieren.', ['failed regression', 'approval checkpoint']],
    ],
    channels: [
        ['Exactly-once Telegram', 'Wiederhole eine Zustellung nach Ack-Verlust nicht doppelt.', ['delivery confirmation', 'dedupe decision']],
        ['Main-Handover-Kontext', 'Stelle den Channel-Kontext nach Main-Wechsel aus Checkpoint wieder her.', ['session checkpoint']],
        ['Toolfehler ehrlich', 'Ein fehlerhaftes Channel-Tool darf keine Erfolgsmeldung erzeugen.', ['failure outcome']],
        ['Freigabe fortsetzen', 'Setze den Channel-Run nach Operator-Freigabe kontrolliert fort.', ['approval record', 'session checkpoint']],
    ],
    governance: [
        ['Budget-Vertrag', 'Stoppe eine Aufgabe, wenn ihr verbindliches Budget überschritten ist.', ['validation report']],
        ['Unverifizierte Antwort', 'Eine Modellantwort ohne Tool-Evidence darf keine Aktion beweisen.', ['verified tool event', 'validation report']],
        ['Feedback-Routing', 'Ordne Zustimmung und Korrektur genau dem betroffenen Run zu.', ['feedback event', 'ordered events']],
        ['Kostenherkunft', 'Kennzeichne Kostenquelle und Schätzung nachvollziehbar im Ledger.', ['cost event']],
    ],
    proactivity: [
        ['Stale Evidence', 'Unterdrücke Warnungen, deren Belege bereits abgelaufen sind.', ['fresh evidence', 'policy decision']],
        ['Fallback-Vorschlag', 'Melde einen Ausfall nur zusammen mit einer verifizierten Ersatzroute.', ['fresh evidence', 'approval state']],
        ['Deduplizierter Alarm', 'Sende denselben belegten Alarm im Dedupe-Fenster nur einmal.', ['budget counter']],
        ['Keine Auto-Mutation', 'Eine proaktive Diagnose darf ohne Freigabe nichts ändern.', ['approval state']],
    ],
}

export function getBenchmarkScenarios(): BenchmarkScenario[] {
    const allTemplates = Object.fromEntries((Object.keys(templates) as BenchmarkCategory[])
        .map(category => [category, [...templates[category], ...extendedTemplates[category]]])) as typeof templates
    return (Object.entries(allTemplates) as Array<[BenchmarkCategory, typeof templates[BenchmarkCategory]]>).flatMap(([category, items]) =>
        items.map(([title, prompt, requiredEvidence], index) => ({
            id: `${category}-${index + 1}`, category, title, prompt: prompt.replace('{n}', String(index + 1)), requiredEvidence,
            timeoutMs: 120_000, destructive: false as const,
        })))
}

export function calculateBenchmarkMetrics(results: BenchmarkObservation[]) {
    const count = Math.max(1, results.length)
    return {
        scenarios: results.length,
        taskCompletionRate: results.filter(item => item.success).length / count,
        correctToolExecutionRate: results.filter(item => item.toolExecuted).length / count,
        resumeRate: results.filter(item => item.resumed).length / Math.max(1, results.filter(item => item.resumed !== undefined).length),
        memoryPrecision: results.filter(item => item.memoryCorrect).length / Math.max(1, results.filter(item => item.memoryCorrect !== undefined).length),
        averageDurationMs: results.reduce((sum, item) => sum + item.durationMs, 0) / count,
        totalCostUsd: results.reduce((sum, item) => sum + Number(item.costUsd || 0), 0),
        unnecessaryQuestions: results.reduce((sum, item) => sum + Number(item.unnecessaryQuestions || 0), 0),
        falseCompletions: results.filter(item => item.falseCompletion).length,
    }
}

export async function runBenchmark(executor: (scenario: BenchmarkScenario) => Promise<BenchmarkObservation>, scenarios = getBenchmarkScenarios()) {
    const results: BenchmarkObservation[] = []
    for (const [index, scenario] of scenarios.entries()) {
        console.log(`[Benchmark] ${index + 1}/${scenarios.length} ${scenario.id} started`)
        const observation = await executor(scenario)
        results.push(observation)
        console.log(`[Benchmark] ${index + 1}/${scenarios.length} ${scenario.id} ${observation.success ? 'passed' : 'failed'} (${observation.durationMs}ms)`)
    }
    const report = { createdAt: new Date().toISOString(), metrics: calculateBenchmarkMetrics(results), results }
    const dir = join(process.cwd(), '.nova-data', 'benchmarks'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${Date.now()}.json`), JSON.stringify(report, null, 2))
    return report
}

export function listBenchmarkReports(limit = 20): Array<Record<string, unknown>> {
    const dir = join(process.cwd(), '.nova-data', 'benchmarks')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(file => file.endsWith('.json')).sort().reverse().slice(0, limit).flatMap(file => {
        try {
            const report = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
            return [{ file, ...report }]
        } catch { return [] }
    })
}
