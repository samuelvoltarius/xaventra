/**
 * Hardware-Aware Role Distribution
 * 
 * Nova detects its platform at startup and adapts behavior:
 * - Desktop/Server → FULL MODE (all layers, all features)
 * - Raspberry Pi   → BRIDGE MODE (lightweight, command relay, Ollama)
 * - Jetson         → VISION MODE (TensorRT, camera, edge inference)
 * - DGX            → COMPUTE MODE (multi-model, training, heavy workloads)
 */

import { existsSync, readFileSync } from 'node:fs'
import { platform, arch, totalmem, cpus, hostname } from 'node:os'
import { execSync } from 'node:child_process'

// ============================================
// Types
// ============================================

export type PlatformType = 'desktop' | 'rpi' | 'jetson' | 'dgx'
export type RoleType = 'full' | 'bridge' | 'vision' | 'compute'

export interface PlatformInfo {
    platform: PlatformType
    name: string
    arch: string
    ram_mb: number
}

export interface HardwareDetails {
    cpuModel: string
    cpuCores: number
    ramGb: number
    gpuModel: string | null
    gpuVram: string | null
    osName: string
    hostname: string
}

export interface RoleConfig {
    platform: PlatformType
    role: RoleType
    roleName: string
    roleEmoji: string

    // Layer toggles
    enableVision: boolean        // L10 Camera/Vision
    enableAST: boolean           // L13 AST Analyzer
    enableSecurityScanner: boolean // L15 Security Scanner
    enableCostTracker: boolean   // L14 Cost Tracker
    enableBusinessSense: boolean // L16 Business Sense
    enableIdleLearning: boolean  // L9 Idle Learning
    enableDashboard: boolean     // Dashboard web UI
    enableWhisper: boolean       // Voice transcription

    // LLM preferences
    preferLocalLLM: boolean      // Prefer Ollama over Cloud
    maxContextTokens: number     // Limit context for low-memory devices

    // Special capabilities
    enableTensorRT: boolean      // Jetson TensorRT engines
    enableMultiModel: boolean    // DGX multi-model parallel
}

// ============================================
// Role Presets
// ============================================

const ROLE_PRESETS: Record<RoleType, Omit<RoleConfig, 'platform'>> = {
    full: {
        role: 'full',
        roleName: 'Full Mode',
        roleEmoji: '🖥️',
        enableVision: true,
        enableAST: true,
        enableSecurityScanner: true,
        enableCostTracker: true,
        enableBusinessSense: true,
        enableIdleLearning: true,
        enableDashboard: true,
        enableWhisper: true,
        preferLocalLLM: false,
        maxContextTokens: 128000,
        enableTensorRT: false,
        enableMultiModel: false,
    },
    bridge: {
        role: 'bridge',
        roleName: 'Bridge Mode',
        roleEmoji: '🌉',
        enableVision: false,
        enableAST: false,
        enableSecurityScanner: false,
        enableCostTracker: true,
        enableBusinessSense: false,
        enableIdleLearning: false,
        enableDashboard: true,
        enableWhisper: false,
        preferLocalLLM: true,
        maxContextTokens: 32000,
        enableTensorRT: false,
        enableMultiModel: false,
    },
    vision: {
        role: 'vision',
        roleName: 'Vision Mode',
        roleEmoji: '👁️',
        enableVision: true,
        enableAST: false,
        enableSecurityScanner: false,
        enableCostTracker: true,
        enableBusinessSense: false,
        enableIdleLearning: true,
        enableDashboard: true,
        enableWhisper: true,
        preferLocalLLM: true,
        maxContextTokens: 64000,
        enableTensorRT: true,
        enableMultiModel: false,
    },
    compute: {
        role: 'compute',
        roleName: 'Compute Mode',
        roleEmoji: '⚡',
        enableVision: true,
        enableAST: true,
        enableSecurityScanner: true,
        enableCostTracker: true,
        enableBusinessSense: true,
        enableIdleLearning: true,
        enableDashboard: true,
        enableWhisper: true,
        preferLocalLLM: false,
        maxContextTokens: 256000,
        enableTensorRT: true,
        enableMultiModel: true,
    },
}

// ============================================
// Detailed Hardware Detection
// ============================================

let cachedHardware: HardwareDetails | null = null

/**
 * Detect detailed hardware specs (GPU, CPU, RAM)
 * Cached after first call — only runs once at startup
 */
export function detectHardwareDetails(): HardwareDetails {
    if (cachedHardware) return cachedHardware

    const cpuInfo = cpus()
    const cpuModel = cpuInfo[0]?.model?.trim() || 'Unknown CPU'
    const cpuCores = cpuInfo.length
    const ramGb = Math.round(totalmem() / 1024 / 1024 / 1024)
    const os = platform()
    const host = hostname()

    let gpuModel: string | null = null
    let gpuVram: string | null = null

    // Try nvidia-smi for GPU detection (Windows + Linux)
    try {
        const nvOut = execSync(
            'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
            { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim()
        if (nvOut) {
            const parts = nvOut.split(',').map(s => s.trim())
            gpuModel = parts[0] || null
            gpuVram = parts[1] ? `${parts[1]} MiB` : null
        }
    } catch {
        // No NVIDIA GPU or nvidia-smi not available
        // Try wmic on Windows as fallback
        if (os === 'win32') {
            try {
                const wmicOut = execSync(
                    'wmic path win32_VideoController get Name /format:value',
                    { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
                ).trim()
                const match = wmicOut.match(/Name=(.+)/i)
                if (match) gpuModel = match[1].trim()
            } catch { /* no GPU info available */ }
        }
    }

    const osName = os === 'win32' ? 'Windows'
        : os === 'darwin' ? 'macOS'
            : os === 'linux' ? 'Linux'
                : os

    cachedHardware = { cpuModel, cpuCores, ramGb, gpuModel, gpuVram, osName, hostname: host }

    console.log(`[HAL] Hardware: ${cpuModel} (${cpuCores} cores), ${ramGb}GB RAM, GPU: ${gpuModel || 'None'} (${gpuVram || 'N/A'})`)

    return cachedHardware
}

/**
 * Get a human-readable one-liner of the host hardware for Nova's persona
 */
export function getHardwareSummary(): string {
    const hw = detectHardwareDetails()
    const parts = [hw.cpuModel, `${hw.ramGb}GB RAM`]
    if (hw.gpuModel) {
        parts.push(`${hw.gpuModel}${hw.gpuVram ? ` (${hw.gpuVram})` : ''}`)
    }
    parts.push(hw.osName)
    return parts.join(', ')
}

// ============================================
// Platform Detection
// ============================================

/**
 * Detect the current platform and assign appropriate role
 */
export function detectPlatformRole(): RoleConfig {
    let platformInfo: PlatformInfo | null = null

    // 1. Try HAL platform-info.json (Linux — written by detect-platform.sh)
    const halPath = '/opt/novaos/hal/platform-info.json'
    if (existsSync(halPath)) {
        try {
            platformInfo = JSON.parse(readFileSync(halPath, 'utf-8'))
            console.log(`[HAL] Platform detected from HAL: ${platformInfo!.name} (${platformInfo!.platform})`)
        } catch {
            console.log('[HAL] ⚠ platform-info.json unreadable, falling back to OS detection')
        }
    }

    // 2. Fallback: OS-level detection
    if (!platformInfo) {
        const os = platform()
        const cpuArch = arch()
        const ramMb = Math.round(totalmem() / 1024 / 1024)

        let detectedPlatform: PlatformType = 'desktop'
        let name = 'Desktop/Server'

        if (os === 'win32' || os === 'darwin') {
            detectedPlatform = 'desktop'
            name = os === 'win32' ? 'Windows Desktop' : 'macOS Desktop'
        } else if (os === 'linux') {
            if (existsSync('/proc/device-tree/compatible')) {
                try {
                    const compatible = readFileSync('/proc/device-tree/compatible', 'utf-8')
                    if (compatible.includes('nvidia,tegra')) {
                        detectedPlatform = 'jetson'
                        name = 'NVIDIA Jetson'
                    }
                } catch { /* not tegra */ }
            }

            if (detectedPlatform === 'desktop' && existsSync('/proc/device-tree/model')) {
                try {
                    const model = readFileSync('/proc/device-tree/model', 'utf-8')
                    if (model.toLowerCase().includes('raspberry')) {
                        detectedPlatform = 'rpi'
                        name = model.replace(/\0/g, '').trim()
                    }
                } catch { /* not rpi */ }
            }

            if (detectedPlatform === 'desktop' && existsSync('/etc/dgx-release')) {
                detectedPlatform = 'dgx'
                name = 'NVIDIA DGX'
            }

            if (detectedPlatform === 'desktop' && cpuArch === 'arm64' && ramMb < 8192) {
                detectedPlatform = 'rpi'
                name = `ARM64 Board (${ramMb}MB RAM)`
            }
        }

        platformInfo = {
            platform: detectedPlatform,
            name,
            arch: cpuArch,
            ram_mb: ramMb,
        }

        console.log(`[HAL] Platform detected from OS: ${name} (${detectedPlatform}, ${cpuArch}, ${ramMb}MB RAM)`)
    }

    // 3. Detect detailed hardware specs (GPU, CPU model, etc.)
    detectHardwareDetails()

    // 4. Map platform → role
    const roleMap: Record<PlatformType, RoleType> = {
        desktop: 'full',
        rpi: 'bridge',
        jetson: 'vision',
        dgx: 'compute',
    }

    const role = roleMap[platformInfo.platform]
    const preset = ROLE_PRESETS[role]

    const config: RoleConfig = {
        ...preset,
        platform: platformInfo.platform,
    }

    const disabledFeatures = []
    if (!config.enableVision) disabledFeatures.push('Vision')
    if (!config.enableAST) disabledFeatures.push('AST')
    if (!config.enableWhisper) disabledFeatures.push('Whisper')
    if (!config.enableIdleLearning) disabledFeatures.push('IdleLearning')
    if (!config.enableSecurityScanner) disabledFeatures.push('Security')

    console.log(`[Nova] ${config.roleEmoji} Role: ${config.roleName.toUpperCase()} (${platformInfo.name})`)
    if (disabledFeatures.length > 0) {
        console.log(`[Nova] 💤 Disabled: ${disabledFeatures.join(', ')}`)
    }
    if (config.enableTensorRT) {
        console.log('[Nova] 🚀 TensorRT engines enabled')
    }
    if (config.enableMultiModel) {
        console.log('[Nova] 🔀 Multi-model parallel inference enabled')
    }

    return config
}

// ============================================
// Singleton
// ============================================

let currentRole: RoleConfig | null = null

export function getPlatformRole(): RoleConfig {
    if (!currentRole) {
        currentRole = detectPlatformRole()
    }
    return currentRole
}

export function isFeatureEnabled(feature: keyof RoleConfig): boolean {
    const role = getPlatformRole()
    return !!role[feature]
}

export default {
    detectPlatformRole,
    getPlatformRole,
    isFeatureEnabled,
    detectHardwareDetails,
    getHardwareSummary,
}
