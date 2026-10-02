import { arch, cpus, platform, totalmem } from 'node:os'
import { OLLAMA_CHAT_MODELS } from '../install/install-catalog.js'
import { NON_CHAT_MODEL_PATTERN } from '../llm/local-llm.js'
import { readOnboardingState, updateOnboardingState, type FirstStartReport, type FirstStartReportItem } from './first-start.js'

// ============================================================================
// 2.85 Paket B, Punkt 2 — Doctor + Selbsteinrichtung als erster Schritt.
//
// Nur vorhandene Wege, keine neuen Befugnisse:
//  - Doctor: runSelfDoctor (Befunde → Fälle wie immer)
//  - Hardware/Selbsteinrichtung: runSelfSetupScan; reparieren nur über das
//    vorhandene Rezept applySelfSetupAction ohne Owner-Code, d. h. Katalog-
//    Einträge gehen in die Installations-Warteschlange (Knopf-Karte, oder
//    dauerhafte Erlaubnis). Config-Patches brauchen weiter den Owner.
//  - Lokales Modell: detectLocalLLMs (Ollama, LM Studio, vLLM, llama.cpp)
//  - Ohne Modell: passender Eintrag aus dem signierten Installationskatalog,
//    vorgeschlagen über proposeCatalogInstall (Ticket-Weg, Karte). Nie selbst
//    installiert.
//  - Was scheitert: Doctor-Befund + Fall (failure-research), den sie verfolgt.
// ============================================================================

export interface FirstStartHardware { platform: string; arch: string; cpus: number; memoryGb: number; gpu: string | null }
export interface FirstStartScanAction { id: string; type: string; title: string; catalogId?: string; applied?: boolean }
export interface FirstStartDoctorDeps {
    hardware(): Promise<FirstStartHardware>
    runDoctor(): Promise<{ findings: number; titles: string[] }>
    scan(): Promise<{ actions: FirstStartScanAction[] }>
    detectLocalModels(): Promise<Array<{ name: string; baseUrl: string; models: string[] }>>
    /** Existing recipe without owner code: catalog action → install queue (card) or standing permission. */
    applyCatalogAction(actionId: string): Promise<{ success: boolean; message: string }>
    proposeInstall(catalogId: string): Promise<{ ok: boolean; status: string; proposalId?: string; message: string }>
    /** Doctor finding + failure-research case. Returns the case id. */
    openCase(input: { key: string; title: string; detail: string; recommendation: string; evidence?: Record<string, unknown> }): string | undefined
    now?(): Date
}


/** Largest catalog chat model that fits this computer's memory, or null. */
export function chooseFirstStartModel(hw: { memoryGb: number }): string | null {
    const fitting = Object.entries(OLLAMA_CHAT_MODELS)
        .filter(([, model]) => hw.memoryGb >= model.minMemoryGb)
        .sort((left, right) => right[1].minMemoryGb - left[1].minMemoryGb)
    return fitting.length ? `ollama-model:${fitting[0][0]}` : null
}

const short = (value: unknown, max = 240) => String((value as any)?.message ?? value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export async function runFirstStartDoctor(deps: FirstStartDoctorDeps): Promise<FirstStartReport> {
    const now = () => (deps.now ? deps.now() : new Date())
    const startedAt = now().toISOString()
    const items: FirstStartReportItem[] = []
    const fail = (step: FirstStartReportItem['step'], key: string, title: string, detail: string, recommendation: string, extra: Partial<FirstStartReportItem> = {}) => {
        let caseId: string | undefined
        try { caseId = deps.openCase({ key: `first-start:${key}`, title, detail, recommendation, evidence: { step } }) } catch { /* the report still says it */ }
        items.push({ step, status: 'gescheitert', text: `${title}: ${detail}${caseId ? ' Ich verfolge das als Doctor-Fall.' : ''}`, ...(caseId ? { caseId } : {}), ...extra })
    }

    // 1. Doctor first.
    try {
        const doctor = await deps.runDoctor()
        items.push(doctor.findings === 0
            ? { step: 'doctor', status: 'ok', text: 'Doctor: keine offenen Befunde.' }
            : { step: 'doctor', status: 'braucht-dich', text: `Doctor: ${doctor.findings} Befund(e), ich verfolge sie als Fälle: ${doctor.titles.slice(0, 3).join('; ')}` })
    } catch (error) {
        fail('doctor', 'doctor', 'Doctor-Lauf gescheitert', short(error), 'Doctor-Lauf beim nächsten Start wiederholen; Protokoll prüfen.')
    }

    // 2. Hardware.
    let hardware: FirstStartHardware = { platform: platform(), arch: arch(), cpus: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), gpu: null }
    try { hardware = await deps.hardware() } catch { /* os values above */ }
    items.push({ step: 'hardware', status: 'ok', text: `Rechner erkannt: ${hardware.platform}/${hardware.arch}, ${hardware.cpus} Kerne, ${hardware.memoryGb} GB Arbeitsspeicher, Grafik: ${hardware.gpu || 'keine erkannt'}.` })

    // 3. Local model, otherwise a fitting catalog model.
    let localModel: FirstStartReport['localModel'] = null
    try {
        for (const server of await deps.detectLocalModels()) {
            const chat = server.models.find(model => model.trim() && !NON_CHAT_MODEL_PATTERN.test(model))
            if (chat) { localModel = { provider: server.name, model: chat, endpoint: server.baseUrl }; break }
        }
    } catch { /* treated as "no model found" */ }
    if (localModel) {
        items.push({ step: 'modell', status: 'ok', text: `Lokales Modell gefunden: ${localModel.model} (${localModel.provider}). Ich arbeite damit, ohne Cloud.` })
    } else {
        const catalogId = chooseFirstStartModel(hardware)
        if (!catalogId) {
            fail('modell', 'modell', 'Kein lokales Modell', `Kein Modell gefunden, und für ${hardware.memoryGb} GB Arbeitsspeicher passt keins aus dem Katalog.`,
                'Einen Rechner mit mehr Speicher aufnehmen oder ein Modell-Konto verbinden.', { catalogId: undefined })
        } else {
            try {
                const proposed = await deps.proposeInstall(catalogId)
                if (proposed.ok && proposed.status === 'queued') {
                    items.push({ step: 'modell', status: 'vorgeschlagen', catalogId, ...(proposed.proposalId ? { proposalId: proposed.proposalId } : {}),
                        text: `Kein lokales Modell gefunden. Vorschlag: ${catalogId.slice('ollama-model:'.length)} (passt zu ${hardware.memoryGb} GB). Ein Ja auf der Karte genügt, dann installiere ich es.` })
                } else if (proposed.ok) {
                    items.push({ step: 'modell', status: 'vorgeschlagen', catalogId, ...(proposed.proposalId ? { proposalId: proposed.proposalId } : {}), text: `Kein lokales Modell gefunden. ${short(proposed.message)}` })
                } else {
                    fail('modell', 'modell', 'Modell nicht installierbar', short(proposed.message), 'Installationsweg (Host-Agent) einrichten oder ein Modell manuell starten.', { catalogId })
                }
            } catch (error) {
                fail('modell', 'modell', 'Modellvorschlag gescheitert', short(error), 'Installations-Warteschlange prüfen.', { catalogId })
            }
        }
    }

    // 4. Self-setup: repair what existing recipes allow, name what needs the owner.
    try {
        const { actions } = await deps.scan()
        for (const action of actions.filter(item => !item.applied).slice(0, 10)) {
            if (action.catalogId) {
                try {
                    const result = await deps.applyCatalogAction(action.id)
                    items.push({ step: 'einrichtung', status: result.success ? 'getan' : 'vorgeschlagen', catalogId: action.catalogId, text: `${action.title}: ${short(result.message)}` })
                } catch (error) {
                    fail('einrichtung', `aktion:${action.id}`, action.title, short(error), 'Aktion über /setup erneut vorschlagen.', { catalogId: action.catalogId })
                }
            } else {
                items.push({ step: 'einrichtung', status: 'braucht-dich', text: `${action.title}: braucht deine Freigabe (/setup apply ${action.id}).` })
            }
        }
    } catch (error) {
        fail('einrichtung', 'einrichtung', 'Selbsteinrichtung gescheitert', short(error), 'Scan beim nächsten Start wiederholen (/setup plan).')
    }

    return { startedAt, finishedAt: now().toISOString(), hardware, localModel, items }
}

const running = new Set<string>()

/** Runs once at a time per installation and stores the report in the first-start marker. */
export async function runAndStoreFirstStartDoctor(deps?: FirstStartDoctorDeps, root = process.cwd()): Promise<FirstStartReport | null> {
    if (readOnboardingState(root)?.state !== 'pending' || running.has(root)) return null
    running.add(root)
    try {
        updateOnboardingState({ doctorRunning: true }, root)
        const report = await runFirstStartDoctor(deps ?? await defaultFirstStartDoctorDeps())
        updateOnboardingState({ doctor: report, doctorRunning: false }, root)
        return report
    } catch (error) {
        updateOnboardingState({ doctorRunning: false }, root)
        throw error
    } finally { running.delete(root) }
}

/** Production wiring: the existing modules, loaded lazily. */
export async function defaultFirstStartDoctorDeps(): Promise<FirstStartDoctorDeps> {
    const [selfDoctor, research, selfSetup] = await Promise.all([
        import('../core/self-doctor.js'), import('../doctor/failure-research-coordinator.js'), import('../core/self-setup-orchestrator.js'),
    ])
    return {
        async hardware() {
            const { probeGpuRuntime } = await import('../doctor/gpu-runtime.js')
            const gpu = await probeGpuRuntime().catch(() => null)
            return { platform: platform(), arch: arch(), cpus: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), gpu: gpu?.detected ? (gpu.name || gpu.vendor) : null }
        },
        async runDoctor() {
            const result = await selfDoctor.runSelfDoctor()
            const open = result.findings.filter(finding => finding.status === 'open')
            return { findings: open.length, titles: open.map(finding => finding.title).filter(Boolean) }
        },
        scan: () => selfSetup.runSelfSetupScan(),
        async detectLocalModels() {
            const { detectLocalLLMs } = await import('../llm/local-llm.js')
            return detectLocalLLMs()
        },
        applyCatalogAction: actionId => selfSetup.applySelfSetupAction(actionId, ''),
        async proposeInstall(catalogId) {
            const { defaultInstallDeps, proposeCatalogInstall, resolveInstallTarget } = await import('../install/install-queue.js')
            const target = await resolveInstallTarget().catch(() => null)
            if (!target) return { ok: false, status: 'refused', message: 'Dieser Rechner hat noch kein Knotenprofil.' }
            const result = proposeCatalogInstall(catalogId, target, defaultInstallDeps(), 'scan')
            return { ok: result.ok, status: result.proposal?.status || 'refused', proposalId: result.proposal?.id, message: result.message }
        },
        openCase(input) {
            const finding = selfDoctor.recordRuntimeDoctorFinding({ ...input, category: 'config', severity: 'warning' })
            return research.getFailureResearchCoordinator().ingest(finding).id
        },
    }
}
