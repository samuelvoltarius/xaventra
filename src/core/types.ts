/**
 * Brutus Core - Main Types
 * Clean, strict TypeScript types for the self-learning bot
 */

import { z } from 'zod/v3'

// ============================================
// Provider & Auth Types
// ============================================

export const ProviderSchema = z.enum([
    'local',
    'openai',
    'anthropic',
    'openai',
    'openai-codex',
])
export type Provider = z.infer<typeof ProviderSchema>

export const AuthModeSchema = z.enum(['oauth', 'api_key', 'token'])
export type AuthMode = z.infer<typeof AuthModeSchema>

export const AuthProfileSchema = z.object({
    provider: ProviderSchema,
    mode: AuthModeSchema,
    token: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
})
export type AuthProfile = z.infer<typeof AuthProfileSchema>

// ============================================
// Message Types
// ============================================

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export const MessageSchema = z.object({
    role: MessageRoleSchema,
    content: z.string(),
    timestamp: z.number().default(() => Date.now()),
    metadata: z.record(z.unknown()).optional(),
})
export type Message = z.infer<typeof MessageSchema>

// ============================================
// LLM Response Types
// ============================================

export interface StreamingChunk {
    content?: string
    done: boolean
}

export interface LLMResponse {
    content: string
    model: string
    usage?: {
        promptTokens: number
        completionTokens: number
        totalTokens: number
    }
}

// ============================================
// Channel Types (WhatsApp, Telegram, etc.)
// ============================================

export const ChannelTypeSchema = z.enum([
    'whatsapp',
    'telegram',
    'matrix',
    'discord',
    'signal',
    'slack',
    'voip',
])
export type ChannelType = z.infer<typeof ChannelTypeSchema>

export const IncomingMessageSchema = z.object({
    id: z.string(),
    channel: ChannelTypeSchema,
    from: z.string(),
    to: z.string().optional(),
    content: z.string(),
    timestamp: z.number(),
    isGroup: z.boolean().default(false),
    groupId: z.string().optional(),
    replyTo: z.string().optional(),
    media: z.array(z.object({
        type: z.enum(['image', 'audio', 'video', 'document']),
        url: z.string(),
        mimeType: z.string().optional(),
    })).optional(),
})
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>

export const OutgoingMessageSchema = z.object({
    channel: ChannelTypeSchema,
    to: z.string(),
    content: z.string(),
    replyTo: z.string().optional(),
})
export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>

// ============================================
// Command Types
// ============================================

export const CommandSchema = z.object({
    name: z.string(),
    args: z.string().optional(),
    raw: z.string(),
})
export type Command = z.infer<typeof CommandSchema>

export interface CommandHandler {
    name: string
    aliases?: string[]
    description: string
    execute: (cmd: Command, msg: IncomingMessage) => Promise<string | null>
}

// ============================================
// Learning Types (Self-Improvement)
// ============================================

export const FeedbackTypeSchema = z.enum(['positive', 'negative', 'correction'])
export type FeedbackType = z.infer<typeof FeedbackTypeSchema>

export const FeedbackSchema = z.object({
    type: FeedbackTypeSchema,
    originalResponse: z.string(),
    correction: z.string().optional(),
    context: z.string().optional(),
    timestamp: z.number().default(() => Date.now()),
})
export type Feedback = z.infer<typeof FeedbackSchema>

export const LearnedPatternSchema = z.object({
    id: z.string(),
    trigger: z.string(),
    response: z.string(),
    confidence: z.number().min(0).max(1),
    usageCount: z.number().default(0),
    createdAt: z.number(),
    updatedAt: z.number(),
})
export type LearnedPattern = z.infer<typeof LearnedPatternSchema>

// ============================================
// Config Types
// ============================================

export const BrutusConfigSchema = z.object({
    // Identity
    name: z.string().default('Brutus'),
    emoji: z.string().default('🤖'),

    // Provider
    provider: ProviderSchema.default('local'),
    model: z.string().default('gpt-5-mini'),

    // Auth profiles
    authProfiles: z.record(z.string(), AuthProfileSchema).optional(),

    // Channels
    enabledChannels: z.array(ChannelTypeSchema).default(['whatsapp']),

    // Learning
    selfLearning: z.boolean().default(true),
    feedbackThreshold: z.number().default(3), // Learn after 3 corrections

    // Gateway
    gateway: z.object({
        port: z.number().default(18789),
        host: z.string().default('0.0.0.0'),
    }).optional(),
})
export type BrutusConfig = z.infer<typeof BrutusConfigSchema>
