/**
 * Client Identity — Single Source of Truth
 * 
 * API client metadata for LLM provider calls.
 * Never hardcode IDE metadata or User-Agent strings elsewhere.
 */

import { platform, arch } from 'node:os'

// ============================================
// Platform Detection
// ============================================

function detectPlatform(): string {
    return 'PLATFORM_UNSPECIFIED'
}

/**
 * Nova SDK version
 */
export const NOVA_SDK_VERSION = '1.18.3'

function detectUserAgent(): string {
    const os = platform()
    const cpu = arch()
    return `nova-core/1.0.0 ${os}/${cpu} sdk/${NOVA_SDK_VERSION}`
}

// ============================================
// Client Metadata
// ============================================

/**
 * IDE metadata sent with API requests.
 */
export const CLIENT_METADATA = {
    ideType: 'VSCODE' as const,
    platform: detectPlatform(),
    pluginType: 'NOVA' as const,
}

/** Serialized metadata for HTTP headers */
export const CLIENT_METADATA_JSON = JSON.stringify(CLIENT_METADATA)

// ============================================
// User-Agent
// ============================================

/** User-Agent header for API requests */
export const USER_AGENT = detectUserAgent()

/** X-Api-Client header */
export const API_CLIENT = `nova-core sdk/${NOVA_SDK_VERSION}`

// ============================================
// Default Project
// ============================================

/**
 * Fallback project ID — only used when discovery fails.
 */
export const DEFAULT_PROJECT_ID = 'nova-default'

// ============================================
// API Endpoints
// ============================================

/** OpenAI API endpoint */
export const CLOUDCODE_ENDPOINT = 'https://api.openai.com'

/**
 * API endpoint fallback chain.
 * All point to OpenAI now.
 */
export const API_ENDPOINTS = [
    'https://api.openai.com',
] as const

/** Primary endpoint */
export const API_ENDPOINT = API_ENDPOINTS[0]


