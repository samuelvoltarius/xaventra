/**
 * Phase 4: activation plan AS DATA. Built from a verified release and node
 * profiles; nothing here executes. A later host agent may run it step by step
 * after an owner approval bound to `planHash`.
 *
 * Native Spark follows runbook 3.4b (activation) and 3.5 (rollback); container
 * workers follow the approved worker swap (backup, verified image, rollback
 * container restart=no). Order: workers first, NAS after the workers, Spark
 * last. No step restarts a host; the NAS host is never restarted.
 */

import { createHash } from 'node:crypto'
import { compareUpdateVersions } from '../github-update.js'
import { PINNED_PUBLISHER_KEY_ID, PINNED_PUBLISHER_SPKI_SHA256, type VerifiedRelease } from './release-watch.js'

export type NodeKind = 'native-spark' | 'container-worker' | 'container-nas' | 'excluded'
export interface NodeProfile {
    nodeId: string
    kind: NodeKind
    arch: 'x64' | 'arm64'
    currentVersion: string
    /** Container name on the host (defaults to the node id). */
    container?: string
}

export type PlanPhase = 'vorher' | 'sicherung' | 'aktivierung' | 'nachher' | 'rueckweg'
export type OnFailure = 'abbrechen-ohne-aenderung' | 'rueckweg' | 'stoppen-melden-nicht-wiederholen'
export interface PlanStep {
    id: string
    nodeId: string
    phase: PlanPhase
    op: string
    title: string
    mutates: boolean
    onFailure: OnFailure
    params: Record<string, unknown>
}
export interface NodePlan {
    nodeId: string
    kind: Exclude<NodeKind, 'excluded'>
    fromVersion: string
    toVersion: string
    hostRestart: false
    steps: PlanStep[]
}
export interface ActivationPlan {
    schema: 1
    kind: 'xaventra-activation-plan'
    version: string
    releaseId: string
    commit: string
    executes: false
    order: string[]
    skipped: Array<{ nodeId: string; reason: string }>
    nodes: NodePlan[]
    /** Forward path in execution order (rollback steps are conditional and stay per node). */
    sequence: PlanStep[]
    invariants: string[]
}

export const PLAN_INVARIANTS = [
    'Plan ist Daten: Ausführung nur durch den Host-Agenten nach Owner-Freigabe, gebunden an planHash.',
    'Reihenfolge: Worker zuerst, NAS danach, Spark zuletzt; ein Knoten erst nach grüner Nachher-Probe des vorigen.',
    'NAS nie neu starten (Host); kein Schritt startet einen Host neu.',
    'Pi und ausgeschlossene Knoten bleiben unberührt.',
    'Spark: Docker-Container nie starten, alter Bridge-Container bleibt aus; im Rückweg kein Docker.',
    'Scheitert eine Vorher-Prüfung: keine Änderung. Mehrdeutige Ergebnisse nie blind wiederholen; Receipts/Locks behalten.',
    'Keine Secrets in Plan, Receipt oder Gedanke; Tokens, Memory, Audits, Backups, Drop-ins und Härtung unverändert.',
    'Nur ein Telegram-Konsument (gültiger Lease); Worker laufen mit NOVA_NODE_ONLY und ohne Telegram.',
]

function architectureLabel(arch: 'x64' | 'arm64'): string { return arch === 'x64' ? 'amd64' : 'arm64' }

type Draft = Omit<PlanStep, 'id' | 'nodeId' | 'onFailure'> & { onFailure?: OnFailure }
const FAILURE: Record<PlanPhase, OnFailure> = {
    vorher: 'abbrechen-ohne-aenderung', sicherung: 'rueckweg', aktivierung: 'rueckweg', nachher: 'rueckweg', rueckweg: 'stoppen-melden-nicht-wiederholen',
}
function step(phase: PlanPhase, op: string, title: string, mutates: boolean, params: Record<string, unknown> = {}): Draft {
    return { phase, op, title, mutates, params }
}

function verifyOnHost(release: VerifiedRelease): Draft {
    return step('vorher', 'verify-release-on-host', 'Release auf dem Host erneut prüfen (gepinnter Schlüssel, Signatur, SHA256SUMS, Deskriptoren)', false, {
        releaseId: release.releaseId, commit: release.commit, publisherKeyId: PINNED_PUBLISHER_KEY_ID, publisherSpkiSha256: PINNED_PUBLISHER_SPKI_SHA256,
        descriptors: release.artifacts.map(a => ({ arch: a.arch, sha256: a.sha256 })),
    })
}

/** Runbook 3.4b + 3.5. */
function sparkSteps(release: VerifiedRelease, node: NodeProfile, image: string): Draft[] {
    const program = `/opt/xaventra-native/${release.version}`
    const root = `/var/lib/xaventra-native-${release.version}-{datum}`
    return [
        verifyOnHost(release),
        step('vorher', 'verify-image-labels', 'Digest-gebundenes Image: Version, Revision, Architektur', false, { image, version: release.version, revision: release.commit, architecture: architectureLabel(node.arch) }),
        step('vorher', 'extract-program-from-image', 'Programm und gebündeltes Node nach /opt extrahieren, Container nie starten', false, { image, target: program, startContainer: false, recordPrepared: `${program}/prepared.json` }),
        step('vorher', 'isolated-lifecycle', 'Isolierter Lebenszyklus der extrahierten Payload als Dienstkonto, ohne Channels', false, { program, checks: 8, channels: false }),
        step('vorher', 'preflight-running-service', 'Laufenden Dienst prüfen (Status, REST-Version); scheitert er: keine Änderung', false, { unit: 'xaventra-native.service', expectVersion: node.currentVersion }),
        step('vorher', 'check-disk-headroom', 'Platz für die unabhängige Datenkopie', false, { path: '/var/lib', minFreeGiB: 40 }),
        step('vorher', 'assert-no-container-writer', 'Kein laufender Container schreibt in die Runtime, alter Telegram-Container aus', false, {}),
        step('sicherung', 'stop-service', 'Dienst stoppen, MainPID 0', true, { unit: 'xaventra-native.service', expectMainPid: 0 }),
        step('sicherung', 'assert-no-writers', 'Null beschreibbare Handles auf der alten Runtime', false, {}),
        step('sicherung', 'freeze-runtime-readonly', 'Alte Runtime read-only bind-fencen', true, { bind: 'ro', note: 'Kernel-Bind überlebt keinen Reboot' }),
        step('sicherung', 'copy-runtime', 'Unabhängige Kopie in den neuen Root', true, { target: `${root}/runtime` }),
        step('sicherung', 'verify-copy-hash', 'Baum-Hash source/copy/source identisch, backup.json', false, { compare: 'source/copy/source', record: `${root}/backup.json` }),
        step('sicherung', 'save-old-unit', 'Alte Unit und Drop-in als old.service im neuen Root sichern', true, { target: `${root}/old.service` }),
        step('aktivierung', 'switch-program-links', 'Nur Programm-Symlinks der Kopie auf das neue Programm', true, { links: ['SOUL.md', 'assets', 'dist', 'node_modules', 'package.json'], program: `${program}/app` }),
        step('aktivierung', 'switch-unit-paths', 'Nur Programm-/Env-/Release-Pfade der Unit ändern', true, { unit: 'xaventra-native.service', unchanged: ['tokens', 'memory', 'audits', 'backups', 'drop-in-hardening'] }),
        step('aktivierung', 'start-service', 'Dienst starten', true, { unit: 'xaventra-native.service' }),
        step('nachher', 'probe-active', 'active, NRestarts 0', false, { nRestarts: 0 }),
        step('nachher', 'probe-version', 'REST HTTP 200 mit neuer Version', false, { http: 200, version: release.version }),
        step('nachher', 'probe-unauthenticated-401', 'Anonymer Status liefert 401', false, { http: 401 }),
        step('nachher', 'probe-model', 'Echte Modell-Probe', false, { expect: 'NATIVE_UPDATE_OK' }),
        step('nachher', 'probe-conversation', 'Gesprächs-Regression', false, {}),
        step('nachher', 'probe-telegram', 'Telegram verbunden, genau ein Konsument', false, { exclusive: true }),
        step('nachher', 'assert-bridge-container-stopped', 'Alter Bridge-Container weiter aus (oder entfernt)', false, {}),
        step('nachher', 'write-receipt', 'receipt.json + backup.json im neuen Root, Zustand zurücklesen', true, { record: `${root}/receipt.json` }),
        step('rueckweg', 'stop-new-service', 'Neuen Dienst stoppen', true, { unit: 'xaventra-native.service' }),
        step('rueckweg', 'assert-mainpid-zero', 'MainPID 0 prüfen', false, {}),
        step('rueckweg', 'restore-old-unit', 'Gesicherte old.service zurück nach /etc/systemd/system', true, { source: `${root}/old.service` }),
        step('rueckweg', 'daemon-reload', 'systemd daemon-reload', true, {}),
        step('rueckweg', 'unmount-readonly-bind', 'Exakten read-only Bind der alten Runtime aushängen', true, {}),
        step('rueckweg', 'start-old-service', 'Alten nativen Dienst starten (kein Docker)', true, { docker: false }),
        step('rueckweg', 'verify-old-version', 'Alte Version per REST bestätigen', false, { version: node.currentVersion }),
        step('rueckweg', 'verify-telegram-exclusive', 'Telegram-Exklusivität prüfen', false, {}),
    ]
}

/** Approved worker swap (worker-swap-2.79.0). */
function containerSteps(release: VerifiedRelease, node: NodeProfile, image: string, nas: boolean): Draft[] {
    const container = node.container || node.nodeId
    const rollback = `${container}-rollback-${release.version}-from-${node.currentVersion}`
    const backup = `{backupRoot}/${container}-${node.currentVersion}-to-${release.version}-{datum}`
    return [
        verifyOnHost(release),
        step('vorher', 'inspect-running', 'Alter Container läuft', false, { container }),
        step('vorher', 'assert-rollback-name-free', 'Rollback-Name noch frei', false, { rollback }),
        step('vorher', 'assert-backup-target-free', 'Backup-Ziel existiert noch nicht', false, { backup }),
        step('vorher', 'pull-image-by-digest', 'Image per Digest holen', false, { image }),
        step('vorher', 'verify-image-labels', 'Image-Version, Revision und Architektur prüfen', false, { image, version: release.version, revision: release.commit, architecture: architectureLabel(node.arch) }),
        step('vorher', 'capture-definition', 'Alte Definition festhalten (Mounts, Limits, User; Env nur Schlüssel)', false, { envValues: false }),
        step('sicherung', 'stop-container', 'Container stoppen (60 s)', true, { container, timeoutSeconds: 60 }),
        step('sicherung', 'backup-runtime', nas ? 'Laufzeit per Btrfs-Reflink sichern' : 'Laufzeit kopieren', true, { target: backup, reflink: nas, mode: '0700' }),
        step('sicherung', 'verify-backup', 'Backup: Dateizahl und Bytes gleich, sonst alten Container wieder starten', false, { compare: ['file-count', 'bytes'], onMismatch: 'start-old-container' }),
        ...(nas ? [step('aktivierung', 'disable-telegram-config', 'Telegram in der Laufzeit-Config aus (nur Main konsumiert)', true, { key: 'channels.telegram.enabled', value: false })] : []),
        step('aktivierung', 'rename-to-rollback', 'Alten Container umbenennen', true, { container, rollback }),
        step('aktivierung', 'set-rollback-restart-no', 'Rollback-Container restart=no', true, { rollback }),
        step('aktivierung', 'run-new-container', 'Neuen Container mit gleichen Mounts, Limits und User starten', true, {
            container, image, network: 'host', readOnly: true, capDrop: 'ALL', noNewPrivileges: true, restart: 'unless-stopped',
            env: { NOVA_NODE_ONLY: 'true', NOVA_NO_TELEGRAM: 'true', NOVA_TELEGRAM_MODE: 'disabled', NOVA_MAIN_ELIGIBLE: 'false', NOVA_MESH_FAILOVER_MAIN: 'false' },
            envFromOldContainer: 'keys-not-from-old-image',
        }),
        step('nachher', 'probe-container', 'Läuft, 0 Restarts', false, { afterSeconds: 20, running: true, restarts: 0 }),
        step('nachher', 'probe-version', 'Version im Container', false, { version: release.version }),
        step('nachher', 'verify-rollback-retained', 'Rollback-Container vorhanden, gestoppt, restart=no', false, { rollback }),
        step('nachher', 'write-receipt', 'Receipt schreiben, Zustand zurücklesen', true, {}),
        step('rueckweg', 'stop-new-container', 'Neuen Container stoppen', true, { container }),
        step('rueckweg', 'start-rollback-container', 'Rollback-Container unter altem Namen starten', true, { rollback, container }),
        step('rueckweg', 'verify-old-version', 'Alte Version bestätigen', false, { version: node.currentVersion }),
    ]
}

export function buildActivationPlan(release: VerifiedRelease, profiles: NodeProfile[]): ActivationPlan {
    if (profiles.filter(p => p.kind === 'native-spark').length > 1) throw Error('Nur ein nativer Spark (Main) pro Plan erlaubt')
    const skipped: ActivationPlan['skipped'] = []
    const due: NodeProfile[] = []
    for (const profile of profiles) {
        if (profile.kind === 'excluded') { skipped.push({ nodeId: profile.nodeId, reason: 'aus jedem Rollout ausgeschlossen' }); continue }
        let newer: boolean
        try { newer = compareUpdateVersions(release.version, profile.currentVersion) > 0 }
        catch { skipped.push({ nodeId: profile.nodeId, reason: 'aktuelle Version unbekannt' }); continue }
        if (!newer) { skipped.push({ nodeId: profile.nodeId, reason: `bereits ${profile.currentVersion}` }); continue }
        due.push(profile)
    }
    const rank = (kind: NodeKind) => kind === 'container-worker' ? 0 : kind === 'container-nas' ? 1 : 2
    due.sort((a, b) => rank(a.kind) - rank(b.kind) || a.nodeId.localeCompare(b.nodeId))
    const nodes: NodePlan[] = due.map(profile => {
        const artifact = release.artifacts.find(a => a.arch === profile.arch)
        if (!artifact) throw Error(`Release hat keinen geprüften Deskriptor für ${profile.arch} (${profile.nodeId})`)
        const drafts = profile.kind === 'native-spark'
            ? sparkSteps(release, profile, artifact.image)
            : containerSteps(release, profile, artifact.image, profile.kind === 'container-nas')
        const counters: Partial<Record<PlanPhase, number>> = {}
        return {
            nodeId: profile.nodeId, kind: profile.kind as NodePlan['kind'], fromVersion: profile.currentVersion, toVersion: release.version, hostRestart: false,
            steps: drafts.map(d => {
                const n = (counters[d.phase] = (counters[d.phase] || 0) + 1)
                return { id: `${profile.nodeId}:${d.phase}:${n}`, nodeId: profile.nodeId, phase: d.phase, op: d.op, title: d.title, mutates: d.mutates, onFailure: d.onFailure || FAILURE[d.phase], params: d.params }
            }),
        }
    })
    return {
        schema: 1, kind: 'xaventra-activation-plan', version: release.version, releaseId: release.releaseId, commit: release.commit,
        executes: false, order: nodes.map(n => n.nodeId), skipped, nodes,
        sequence: nodes.flatMap(n => n.steps.filter(s => s.phase !== 'rueckweg')),
        invariants: [...PLAN_INVARIANTS],
    }
}

export function planHash(plan: ActivationPlan): string {
    return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

export function summarizeActivationPlan(plan: ActivationPlan): string {
    return plan.nodes.map((n, i) => i === plan.nodes.length - 1 && n.kind === 'native-spark' ? `${n.nodeId} (zuletzt)` : n.nodeId).join(' → ') || 'nichts zu tun'
}
