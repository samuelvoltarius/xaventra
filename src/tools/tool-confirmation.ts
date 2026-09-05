/**
 * Nova Tool Confirmation System
 * 
 * Based on ADA V2's tool_permissions:
 * - Requires user confirmation before executing sensitive tools
 * - Tools requiring approval: cad_generate, printer_print, run_command, write_file
 * - Confirmation stored in session for duration of conversation
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const TOOL_CONFIRM_DIR = join(process.cwd(), '.nova-data', 'tool-confirmations')
const CONFIRMATION_TTL = 300_000 // 5 minutes

interface PendingConfirmation {
    toolName: string
    toolArgs: Record<string, unknown>
    userId: string
    channel: string
    timestamp: number
    description: string
}

interface ConfirmationResult {
    approved: boolean
    userId: string
    toolName: string
    timestamp: number
}

// In-memory store for pending confirmations
const pendingConfirmations = new Map<string, ConfirmationResult>()
const pendingToolCalls = new Map<string, PendingConfirmation>()

export const toolConfirmationTool = {
    name: 'tool_confirm',
    description: 'Request user confirmation before executing a sensitive tool. Returns confirmation status.',
    category: 'system' as const,
    parameters: [
        {
            name: 'toolName',
            type: 'string',
            description: 'Name of the tool to confirm',
            required: true
        },
        {
            name: 'action',
            type: 'string',
            description: 'Action: "request" (create pending confirmation), "check" (check if approved), "approve", "deny"',
            required: true
        },
        {
            name: 'userId',
            type: 'string',
            description: 'User ID requesting confirmation',
            required: false
        },
        {
            name: 'toolArgs',
            type: 'object',
            description: 'Tool arguments for context',
            required: false
        },
        {
            name: 'confirmationId',
            type: 'string',
            description: 'Confirmation ID (for approve/deny actions)',
            required: false
        }
    ],
    handler: async (params: {
        toolName: string
        action: 'request' | 'check' | 'approve' | 'deny'
        userId?: string
        toolArgs?: Record<string, unknown>
        confirmationId?: string
        channel?: string
    }) => {
        const { toolName, action, userId = 'unknown', toolArgs = {}, confirmationId, channel = 'telegram' } = params
        
        // Sensitive tools that require confirmation
        const SENSITIVE_TOOLS = [
            'cad_generate',
            'printer_print',
            'run_command',
            'write_file',
            'ssh_execute',
            'browser_control',
            'system_shutdown',
            'delete_file'
        ]
        
        const isSensitive = SENSITIVE_TOOLS.includes(toolName)
        
        switch (action) {
            case 'request':
                if (!isSensitive) {
                    // Auto-approve non-sensitive tools
                    return {
                        success: true,
                        autoApproved: true,
                        toolName,
                        message: 'Tool does not require confirmation'
                    }
                }
                
                const confId = `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2)}`
                const pending: PendingConfirmation = {
                    toolName,
                    toolArgs,
                    userId,
                    channel,
                    timestamp: Date.now(),
                    description: generateConfirmationDescription(toolName, toolArgs)
                }
                
                pendingToolCalls.set(confId, pending)
                
                return {
                    success: true,
                    confirmationId: confId,
                    requiresConfirmation: true,
                    toolName,
                    description: pending.description,
                    message: `Confirmation required for ${toolName}. Ask user to approve via /tool approve ${confId}`,
                    pending: true
                }
                
            case 'check':
                if (!confirmationId) {
                    return { success: false, error: 'confirmationId required for check' }
                }
                
                const pendingConf = pendingToolCalls.get(confirmationId)
                if (!pendingConf) {
                    return { success: false, error: 'Confirmation not found or expired' }
                }
                
                const isExpired = Date.now() - pendingConf.timestamp > CONFIRMATION_TTL
                if (isExpired) {
                    pendingToolCalls.delete(confirmationId)
                    return { success: false, error: 'Confirmation expired' }
                }
                
                return {
                    success: true,
                    confirmed: false,
                    toolName: pendingConf.toolName,
                    description: pendingConf.description,
                    pending: true
                }
                
            case 'approve':
                if (!confirmationId || !userId) {
                    return { success: false, error: 'confirmationId and userId required for approve' }
                }
                
                const toApprove = pendingToolCalls.get(confirmationId)
                if (!toApprove) {
                    return { success: false, error: 'Confirmation not found' }
                }
                
                pendingConfirmations.set(confirmationId, {
                    approved: true,
                    userId,
                    toolName,
                    timestamp: Date.now()
                })
                pendingToolCalls.delete(confirmationId)
                
                return {
                    success: true,
                    approved: true,
                    toolName,
                    message: `${toolName} approved by ${userId}`
                }
                
            case 'deny':
                if (!confirmationId || !userId) {
                    return { success: false, error: 'confirmationId and userId required for deny' }
                }
                
                pendingConfirmations.set(confirmationId, {
                    approved: false,
                    userId,
                    toolName,
                    timestamp: Date.now()
                })
                pendingToolCalls.delete(confirmationId)
                
                return {
                    success: true,
                    approved: false,
                    toolName,
                    message: `${toolName} denied by ${userId}`
                }
                
            default:
                return { success: false, error: `Unknown action: ${action}` }
        }
    }
}

function generateConfirmationDescription(toolName: string, toolArgs: Record<string, unknown>): string {
    switch (toolName) {
        case 'cad_generate':
            return `Generate 3D CAD model: ${toolArgs.description || 'unspecified'}`
        case 'printer_print':
            return `Print file: ${toolArgs.gcodeFile || toolArgs.stlFile || 'unspecified'}`
        case 'run_command':
            return `Execute command: ${toolArgs.command || 'unspecified'}`
        case 'write_file':
            return `Write file: ${toolArgs.filePath || toolArgs.path || 'unspecified'}`
        case 'ssh_execute':
            return `SSH command on ${toolArgs.host || 'remote'}: ${toolArgs.command || 'unspecified'}`
        case 'browser_control':
            return `Control browser: ${toolArgs.action || 'unspecified'}`
        case 'delete_file':
            return `Delete file: ${toolArgs.path || toolArgs.filePath || 'unspecified'}`
        default:
            return `Execute ${toolName} with args: ${JSON.stringify(toolArgs).slice(0, 100)}`
    }
}

export function isToolConfirmed(confirmationId: string): boolean {
    const result = pendingConfirmations.get(confirmationId)
    if (!result) return false
    
    const isExpired = Date.now() - result.timestamp > CONFIRMATION_TTL
    if (isExpired) {
        pendingConfirmations.delete(confirmationId)
        return false
    }
    
    return result.approved
}

export function getPendingConfirmations(): Map<string, PendingConfirmation> {
    // Clean expired
    for (const [id, conf] of pendingToolCalls.entries()) {
        if (Date.now() - conf.timestamp > CONFIRMATION_TTL) {
            pendingToolCalls.delete(id)
        }
    }
    return pendingToolCalls
}

export default { toolConfirmationTool, isToolConfirmed, getPendingConfirmations }