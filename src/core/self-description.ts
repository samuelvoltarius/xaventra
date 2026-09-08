export const XAVENTRA_IDENTITY = 'Ich bin Xaventra, dein selbstgehosteter AI-Assistent. Ich nutze deine Modelle, dein Mesh und freigegebene Tools. Änderungen bleiben an Berechtigungen, Freigaben und überprüfbare Ergebnisse gebunden.'

/** Registry evidence is not proof of host access or a functioning service. */
export function describeRegisteredCapabilities(tools: Array<{ name: string }>, permission: string): string {
    const names = new Set(tools.map(tool => tool.name))
    const groups: Array<[string, string[]]> = [
        ['Dateien und Code', ['read_file', 'find_files', 'code_search', 'write_file']],
        ['Erinnerungen', ['remember', 'kg_search', 'knowledge_store']],
        ['Web-Recherche', ['browser_search', 'brave_search', 'google_search', 'web_search']],
        ['Systemdiagnose', ['health_status', 'nova_introspect']],
    ]
    const registered = groups.flatMap(([label, candidates]) => {
        const present = candidates.filter(name => names.has(name))
        return present.length ? [`${label}: ${present.join(', ')}`] : []
    })
    return [
        'Ich bin Xaventra. Ich kann Anfragen bearbeiten und freigegebene Werkzeuge verwenden.',
        `Deine Rolle in dieser Sitzung: ${permission}.`,
        '',
        registered.length ? 'Im laufenden Tool-Katalog registriert (keine Ausführungsfreigabe):' : 'Ein verifizierter Tool-Katalog ist gerade nicht verfügbar.',
        ...registered,
        '',
        'Ob ein Tool für deinen Auftrag erlaubt und sein Dienst erreichbar ist, muss ich vor der Nutzung prüfen. Registriert bedeutet nicht einsatzbereit.',
        'Internet, Host-Docker-Zugriff, SSH-Zugänge und installierbare Pakete sind durch diese Übersicht nicht geprüft.',
        'Installationen und Selbständerungen benötigen die geltenden Freigaben; ich darf Sicherheitsregeln nicht umgehen.',
    ].join('\n')
}
