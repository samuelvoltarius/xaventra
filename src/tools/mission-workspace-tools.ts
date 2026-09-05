import type { NovaTool } from './complete-registry.js'
import { getMissionWorkspaceManager, type MissionWorkspaceMode } from '../runtime/mission-workspace.js'

export const missionWorkspaceTools: NovaTool[] = [
    {
        name: 'mission_workspace_create',
        description: 'Erstellt für eine schreibende Mission einen isolierten temporären Bereich, Git-Worktree oder gehärteten Container. Änderungen bleiben bis zur Operator-Prüfung isoliert.',
        category: 'system',
        parameters: [
            { name: 'mission_id', type: 'string', description: 'Mission-ID' },
            { name: 'mode', type: 'string', description: 'temporary, worktree, container oder native' },
            { name: 'repository', type: 'string', description: 'Repository für worktree' },
            { name: 'base_ref', type: 'string', description: 'Git-Basisreferenz' },
            { name: 'container_image', type: 'string', description: 'Freigegebenes Container-Image' },
            { name: 'sandbox_backend', type: 'string', description: 'Optional: bubblewrap, landlock oder seatbelt' },
        ],
        handler: async params => getMissionWorkspaceManager().create({
            missionId: params.mission_id ? String(params.mission_id) : undefined,
            mode: params.mode ? String(params.mode) as MissionWorkspaceMode : undefined,
            repository: params.repository ? String(params.repository) : undefined,
            baseRef: params.base_ref ? String(params.base_ref) : undefined,
            containerImage: params.container_image ? String(params.container_image) : undefined,
            sandboxBackend: params.sandbox_backend ? String(params.sandbox_backend) as any : undefined,
        }),
    },
    {
        name: 'mission_workspace_list',
        description: 'Listet isolierte Missions-Workspaces samt Review-Status. Funktioniert ohne Slash-Befehl.',
        category: 'system', parameters: [],
        handler: async () => ({ workspaces: getMissionWorkspaceManager().list() }),
    },
    {
        name: 'mission_workspace_diff',
        description: 'Zeigt den prüfbaren Diff eines Missions-Worktrees, ohne ihn zu übernehmen.',
        category: 'system',
        parameters: [{ name: 'workspace_id', type: 'string', description: 'Workspace-ID', required: true }],
        handler: async params => ({ workspaceId: String(params.workspace_id), diff: await getMissionWorkspaceManager().diff(String(params.workspace_id)) }),
    },
    {
        name: 'mission_workspace_run',
        description: 'Führt einen Befehl ohne Shell-Injektion mit getrennten Argumenten innerhalb eines isolierten Missions-Workspace aus.',
        category: 'system',
        parameters: [
            { name: 'workspace_id', type: 'string', description: 'Workspace-ID; wird im isolierten Agent-Kontext automatisch gebunden', required: true },
            { name: 'command', type: 'string', description: 'Ausführbare Datei, kein Shell-String', required: true },
            { name: 'args', type: 'object', description: 'Argumentliste' },
            { name: 'timeout_ms', type: 'number', description: 'Timeout bis 10 Minuten' },
        ],
        handler: async params => getMissionWorkspaceManager().run(
            String(params.workspace_id), String(params.command), Array.isArray(params.args) ? params.args.map(String) : [],
            { timeoutMs: Math.min(600_000, Math.max(100, Number(params.timeout_ms || 120_000))) },
        ),
    },
]
