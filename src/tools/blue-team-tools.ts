import type { NovaTool } from './complete-registry.js'
import { getBlueTeamService, type BlueSeverity } from '../security/blue-team.js'

export const blueTeamTools: NovaTool[] = [
    {
        name: 'blue_incident_start',
        description: 'Startet einen defensiven Blue-Team-Fall mit unveränderbarer Evidence-Kette. Keine Angriffsaktion.',
        category: 'security',
        parameters: [
            { name: 'title', type: 'string', description: 'Kurzer Incident-Titel', required: true },
            { name: 'scope', type: 'string', description: 'Betroffene Nova-Assets oder Dienste' },
            { name: 'severity', type: 'string', description: 'info, low, medium, high oder critical' },
        ],
        handler: async params => getBlueTeamService().createIncident(String(params.title), String(params.scope || 'nova-managed-assets'), String(params.severity || 'medium') as BlueSeverity),
    },
    {
        name: 'blue_asset_inventory',
        description: 'Erfasst defensiv den lokalen Host und verifizierte Mesh-Capabilities; führt keine Scans fremder Ziele aus.',
        category: 'security', parameters: [],
        handler: async () => getBlueTeamService().inventory(),
    },
    {
        name: 'blue_log_triage',
        description: 'Analysiert eine erlaubte lokale Nova-/System-Logdatei auf defensive Sicherheits- und Stabilitätssignale.',
        category: 'security',
        parameters: [
            { name: 'path', type: 'string', description: 'Logpfad innerhalb eines konfigurierten Blue-Team-Roots', required: true },
            { name: 'incident_id', type: 'string', description: 'Optionaler Incident für signierte Evidence' },
        ],
        handler: async params => {
            const service = getBlueTeamService()
            const report = service.analyzeLog(String(params.path))
            if (params.incident_id) service.addEvidence(String(params.incident_id), 'log', report.path, `${report.findings.length} defensive findings`, { findings: report.findings.slice(0, 50) })
            return report
        },
    },
    {
        name: 'blue_ioc_check',
        description: 'Vergleicht bekannte defensive Indicators of Compromise mit Text oder einer erlaubten Logdatei.',
        category: 'security',
        parameters: [
            { name: 'indicators', type: 'object', description: 'Liste aus Hashes, Domains, IPs oder Dateinamen', required: true },
            { name: 'source', type: 'string', description: 'Text oder erlaubter lokaler Pfad', required: true },
            { name: 'incident_id', type: 'string', description: 'Optionaler Incident für Evidence' },
        ],
        handler: async params => {
            const service = getBlueTeamService()
            const indicators = Array.isArray(params.indicators) ? params.indicators.map(String) : []
            const report = service.checkIndicators(indicators, String(params.source))
            if (params.incident_id) service.addEvidence(String(params.incident_id), 'ioc', 'local-ioc-match', `${report.matches.length} IOC matches`, { matches: report.matches })
            return report
        },
    },
    {
        name: 'blue_dependency_audit',
        description: 'Prüft Nova-Abhängigkeiten defensiv per npm audit. Keine Pakete werden automatisch verändert.',
        category: 'security',
        parameters: [{ name: 'repository', type: 'string', description: 'Nova-Workspace; standardmäßig aktuelles Projekt' }, { name: 'incident_id', type: 'string', description: 'Optionaler Incident' }],
        handler: async params => {
            const service = getBlueTeamService()
            const report = await service.dependencyAudit(String(params.repository || process.cwd()))
            if (params.incident_id) service.addEvidence(String(params.incident_id), 'dependency', 'npm-audit', 'Dependency audit completed', { metadata: (report as any).metadata })
            return report
        },
    },
    {
        name: 'blue_incident_timeline',
        description: 'Zeigt die kausale, hashverkettete Timeline eines Blue-Team-Incidents und validiert die Evidence-Kette.',
        category: 'security',
        parameters: [{ name: 'incident_id', type: 'string', description: 'Incident-ID', required: true }],
        handler: async params => {
            const service = getBlueTeamService()
            return { incident: service.getIncident(String(params.incident_id)), chain: service.verifyEvidenceChain(String(params.incident_id)) }
        },
    },
    {
        name: 'blue_containment_plan',
        description: 'Erstellt einen defensiven Containment-Plan. Führt keine Änderung aus; Eingriffe benötigen Owner/PATCH_GATE, Sandbox und Nachprüfung.',
        category: 'security',
        parameters: [{ name: 'incident_id', type: 'string', description: 'Incident-ID', required: true }],
        handler: async params => getBlueTeamService().containmentPlan(String(params.incident_id)),
    },
]
