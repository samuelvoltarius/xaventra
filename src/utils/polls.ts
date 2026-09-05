/**
 * Nova Polls System
 * 
 * Inspired by OpenClaw's polls.ts (3KB)
 * Simple poll creation, voting, and results.
 */

import { randomBytes } from 'node:crypto'

// ============================================
// Types
// ============================================

export interface PollOption {
    id: string
    text: string
    votes: number
    voters: string[]
}

export interface Poll {
    id: string
    question: string
    options: PollOption[]
    createdAt: number
    expiresAt?: number
    createdBy: string
    allowMultiple: boolean
    anonymous: boolean
    closed: boolean
}

// ============================================
// Poll Store
// ============================================

const polls = new Map<string, Poll>()

export function createPoll(params: {
    question: string
    options: string[]
    createdBy?: string
    ttlMs?: number
    allowMultiple?: boolean
    anonymous?: boolean
}): Poll {
    const id = `poll_${randomBytes(4).toString('hex')}`
    const poll: Poll = {
        id,
        question: params.question,
        options: params.options.map((text, idx) => ({
            id: `opt_${idx}`,
            text,
            votes: 0,
            voters: [],
        })),
        createdAt: Date.now(),
        expiresAt: params.ttlMs ? Date.now() + params.ttlMs : undefined,
        createdBy: params.createdBy || 'system',
        allowMultiple: params.allowMultiple || false,
        anonymous: params.anonymous || false,
        closed: false,
    }
    polls.set(id, poll)
    return poll
}

export function vote(pollId: string, optionId: string, voterId: string): { success: boolean; error?: string } {
    const poll = polls.get(pollId)
    if (!poll) return { success: false, error: 'Poll not found' }
    if (poll.closed) return { success: false, error: 'Poll is closed' }
    if (poll.expiresAt && Date.now() > poll.expiresAt) {
        poll.closed = true
        return { success: false, error: 'Poll has expired' }
    }

    const option = poll.options.find(o => o.id === optionId)
    if (!option) return { success: false, error: 'Option not found' }

    if (!poll.allowMultiple) {
        const alreadyVoted = poll.options.some(o => o.voters.includes(voterId))
        if (alreadyVoted) return { success: false, error: 'Already voted' }
    }

    if (option.voters.includes(voterId)) return { success: false, error: 'Already voted for this option' }

    option.votes++
    option.voters.push(voterId)
    return { success: true }
}

export function closePoll(pollId: string): boolean {
    const poll = polls.get(pollId)
    if (!poll) return false
    poll.closed = true
    return true
}

export function getPoll(pollId: string): Poll | undefined {
    return polls.get(pollId)
}

export function listPolls(activeOnly = false): Poll[] {
    const all = [...polls.values()]
    if (activeOnly) return all.filter(p => !p.closed && (!p.expiresAt || Date.now() <= p.expiresAt))
    return all
}

export function deletePoll(pollId: string): boolean {
    return polls.delete(pollId)
}

// ============================================
// Results Formatting
// ============================================

export function formatPollResults(poll: Poll): string {
    const totalVotes = poll.options.reduce((sum, o) => sum + o.votes, 0)
    const lines = [
        `📊 **${poll.question}**`,
        poll.closed ? '(Closed)' : '',
        '',
    ]

    for (const option of poll.options) {
        const pct = totalVotes > 0 ? Math.round((option.votes / totalVotes) * 100) : 0
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5))
        lines.push(`${option.text}: ${bar} ${pct}% (${option.votes})`)
    }

    lines.push(`\nTotal votes: ${totalVotes}`)
    return lines.filter(l => l !== '').join('\n')
}

export function formatPollMessage(poll: Poll): string {
    const lines = [
        `📊 **${poll.question}**`,
        '',
        ...poll.options.map((o, idx) => `${idx + 1}. ${o.text}`),
        '',
        poll.allowMultiple ? '(Multiple votes allowed)' : '(Single vote only)',
        `Reply with the number to vote. Poll ID: ${poll.id}`,
    ]
    return lines.join('\n')
}
