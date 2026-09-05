import type { NovaTool } from './complete-registry.js'

export const developerCapabilityTools: NovaTool[] = [
    {
        name: 'lsp_query',
        description: 'Führt eine normalisierte Language-Service-Abfrage für Definitionen, Referenzen, Symbole oder Diagnosen innerhalb eines Workspace aus.',
        category: 'file',
        parameters: [
            { name: 'root', type: 'string', description: 'Workspace-Wurzel', required: true },
            { name: 'operation', type: 'string', description: 'definition | references | symbols | diagnostics', required: true },
            { name: 'file', type: 'string', description: 'Datei innerhalb der Workspace-Wurzel', required: true },
            { name: 'line', type: 'number', description: 'Zeile (1-basiert)' },
            { name: 'column', type: 'number', description: 'Spalte (1-basiert)' },
            { name: 'query', type: 'string', description: 'Optionale Symbolsuche' },
        ],
        handler: async params => {
            const { getLspRuntime } = await import('../runtime/lsp-runtime.js')
            return getLspRuntime().query(String(params.root), {
                operation: String(params.operation) as any,
                file: String(params.file),
                line: params.line === undefined ? undefined : Number(params.line),
                column: params.column === undefined ? undefined : Number(params.column),
                query: params.query === undefined ? undefined : String(params.query),
            })
        },
    },
    {
        name: 'code_runtime_run',
        description: 'Führt JavaScript in einem kurzlebigen, netzwerkisolierten Mission-Container aus. Kein Host-eval und keine freie Shell.',
        category: 'system',
        parameters: [
            { name: 'code', type: 'string', description: 'JavaScript-Programm', required: true },
            { name: 'timeout_ms', type: 'number', description: 'Timeout bis 120 Sekunden' },
            { name: 'image', type: 'string', description: 'Optionales freigegebenes Container-Image' },
        ],
        handler: async params => {
            const { getCodeRuntime } = await import('../runtime/code-runtime.js')
            return getCodeRuntime().execute({
                language: 'javascript', code: String(params.code),
                timeoutMs: params.timeout_ms === undefined ? undefined : Number(params.timeout_ms),
                image: params.image === undefined ? undefined : String(params.image),
            })
        },
    },
    {
        name: 'continuable_subagent_start',
        description: 'Startet eine persistente Subagent-Konversation, die nach Neustart oder Main-Wechsel fortgesetzt werden kann.',
        category: 'other',
        parameters: [
            { name: 'task', type: 'string', description: 'Fokussierter Auftrag', required: true },
            { name: 'tools', type: 'object', description: 'Optionale Tool-Allowlist' },
            { name: 'mesh_node', type: 'string', description: 'Optionaler Mesh-Node' },
        ],
        handler: async params => {
            const { getContinuableSubagentRuntime } = await import('../agents/continuable-subagents.js')
            return getContinuableSubagentRuntime().start({
                task: String(params.task),
                tools: Array.isArray(params.tools) ? params.tools.map(String) : undefined,
                meshNode: params.mesh_node ? String(params.mesh_node) : undefined,
            })
        },
    },
    {
        name: 'continuable_subagent_followup',
        description: 'Setzt eine persistente Subagent-Konversation anhand ihres dauerhaften Checkpoints fort.',
        category: 'other',
        parameters: [
            { name: 'conversation_id', type: 'string', description: 'Persistente Conversation-ID', required: true },
            { name: 'prompt', type: 'string', description: 'Nächster Auftrag', required: true },
        ],
        handler: async params => {
            const { getContinuableSubagentRuntime } = await import('../agents/continuable-subagents.js')
            return getContinuableSubagentRuntime().followup(String(params.conversation_id), String(params.prompt))
        },
    },
    {
        name: 'runtime_capabilities',
        description: 'Zeigt LSP-, Code-Runtime-, Sandbox- und fortsetzbare Subagent-Provider ohne Credentials.',
        category: 'system', parameters: [],
        handler: async () => {
            const [{ getLspRuntime }, { getCodeRuntime }, { getSandboxRegistry }, { getContinuableSubagentRuntime }] = await Promise.all([
                import('../runtime/lsp-runtime.js'), import('../runtime/code-runtime.js'), import('../runtime/sandbox-provider.js'), import('../agents/continuable-subagents.js'),
            ])
            return { lsp: getLspRuntime().list(), code: getCodeRuntime().list(), sandbox: getSandboxRegistry().list(), subagents: getContinuableSubagentRuntime().listProviders() }
        },
    },
]
