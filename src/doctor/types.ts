/**
 * Nova Doctor — Type Definitions
 *
 * The doctor report is always built deterministically (no LLM, no network except
 * Ollama probe). It becomes the compact context handed to the small local model
 * when that feature is added.
 */

// ============================================
// Issue codes — one per known problem class
// ============================================

export type IssueCode =
    // Config
    | 'CONFIG_MISSING'
    | 'CONFIG_INVALID_JSON'
    | 'CONFIG_UNKNOWN_PROVIDER'
    // Environment
    | 'ENV_FILE_MISSING'
    | 'NODE_VERSION_OLD'
    // LLM Providers
    | 'LLM_PROVIDER_NOT_SET'
    | 'LLM_API_KEY_MISSING'
    | 'OLLAMA_UNREACHABLE'
    | 'OLLAMA_NO_MODELS'
    // Channels
    | 'TELEGRAM_ENABLED_NO_TOKEN'
    | 'TELEGRAM_TOKEN_INVALID_FORMAT'
    | 'DISCORD_ENABLED_NO_TOKEN'
    | 'WHATSAPP_ENABLED_NO_AUTH'
    | 'SLACK_ENABLED_NO_TOKEN'
    // Ports
    | 'PORT_REST_OCCUPIED'
    | 'PORT_MESH_OCCUPIED'
    // Build / Runtime
    | 'DIST_MISSING'
    | 'DIST_STALE'
    | 'NODE_MODULES_MISSING'
    // GPU / native inference
    | 'GPU_ACCELERATION_UNAVAILABLE'
    | 'GPU_BINDING_PACKAGE_MISSING'
    | 'CUDA_RUNTIME_MISSING'
    // SSH
    | 'SSH_KEY_MISSING'

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface DoctorFix {
    type: 'command' | 'config_patch' | 'ask_user' | 'info'
    // For config_patch: path (dot notation) + value
    configPath?: string
    configValue?: unknown
    // For command:
    command?: string
    // For ask_user:
    promptText?: string
    envKey?: string
    // Human-readable hint
    hint: string
    safe: boolean  // true = can be applied automatically
}

export interface DoctorIssue {
    code: IssueCode
    severity: IssueSeverity
    message: string     // Short human-readable description
    detail?: string     // Extra context
    fix?: DoctorFix     // How to resolve it
}

// ============================================
// Check results — one per check category
// ============================================

export interface CheckResult {
    ok: boolean
    label: string           // e.g. "nova.config.json"
    status: string          // e.g. "gültig" / "fehlt" / "ungültiges JSON"
    issues: DoctorIssue[]
}

// ============================================
// Full report
// ============================================

export interface DoctorReport {
    timestamp: string
    version: string
    platform: string        // process.platform
    nodeVersion: string     // process.version
    cwd: string

    checks: {
        config:   CheckResult
        env:      CheckResult
        runtime:  CheckResult
        gpu:      CheckResult
        ports:    CheckResult
        providers: CheckResult
        channels: CheckResult
        mesh:     CheckResult
    }

    // Flat list of all issues, sorted: errors first
    issues: DoctorIssue[]

    summary: {
        errors:   number
        warnings: number
        infos:    number
        ok:       number
        healthy:  boolean
    }

    // Config snapshot (non-secret fields only)
    configSnapshot?: {
        provider?: string
        model?: string
        channels?: Record<string, boolean>
        restPort?: number
        meshPort?: number
    }
}

export interface ApplyFixResult {
    applied: boolean
    message: string
    requiresRestart?: boolean
}
