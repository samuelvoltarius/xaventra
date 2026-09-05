/**
 * L24 — Prompt Self-Optimization
 * 
 * Nova analyzes which parts of her system prompt lead to:
 * - Hallucinations
 * - Wrong language
 * - Over-verbose responses
 * - Ignored instructions
 * 
 * During dream cycles, she proposes SOUL.md modifications.
 * LOCKED sections in SOUL.md cannot be changed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'l24-prompt-opt')
const SOUL_PATH = join(process.cwd(), 'SOUL.md')

// ============================================
// Types
// ============================================

interface PromptIssue {
    timestamp: string
    section: string       // Which part of SOUL.md
    issue: string         // What went wrong
    category: 'hallucination' | 'language' | 'verbosity' | 'ignored' | 'tone'
    frequency: number     // How often this happens
}

interface PromptOptimization {
    timestamp: string
    section: string
    original: string
    proposed: string
    reason: string
    applied: boolean
}

// ============================================
// SOUL.md Parser — respects [LOCKED] sections
// ============================================

interface SoulSection {
    header: string
    content: string
    locked: boolean
    startLine: number
    endLine: number
}

/**
 * Parse SOUL.md into sections, marking [LOCKED] ones
 */
export function parseSoulSections(): SoulSection[] {
    if (!existsSync(SOUL_PATH)) return []

    const content = readFileSync(SOUL_PATH, 'utf-8')
    const lines = content.split('\n')
    const sections: SoulSection[] = []
    let currentSection: SoulSection | null = null

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        // New section starts with ## or #
        if (line.match(/^#{1,3}\s/)) {
            if (currentSection) {
                currentSection.endLine = i - 1
                sections.push(currentSection)
            }

            const locked = line.includes('[LOCKED]') || line.includes('[GESPERRT]')
            currentSection = {
                header: line.replace(/\[LOCKED\]|\[GESPERRT\]/g, '').trim(),
                content: '',
                locked,
                startLine: i,
                endLine: i,
            }
        } else if (currentSection) {
            currentSection.content += line + '\n'
        }
    }

    if (currentSection) {
        currentSection.endLine = lines.length - 1
        sections.push(currentSection)
    }

    return sections
}

/**
 * Check if a section is modifiable
 */
export function isSectionLocked(sectionHeader: string): boolean {
    const sections = parseSoulSections()
    const section = sections.find(s => s.header.includes(sectionHeader))
    return section?.locked ?? true  // Default: locked (safe)
}

// ============================================
// Issue Tracking
// ============================================

let issues: PromptIssue[] = []

/**
 * Record a prompt-related issue
 */
export function recordPromptIssue(section: string, issue: string, category: PromptIssue['category']): void {
    const existing = issues.find(i => i.section === section && i.category === category)
    if (existing) {
        existing.frequency++
        existing.timestamp = new Date().toISOString()
    } else {
        issues.push({
            timestamp: new Date().toISOString(),
            section,
            issue,
            category,
            frequency: 1,
        })
    }

    // Keep max 50
    if (issues.length > 50) issues = issues.slice(-50)
    saveIssues()
}

/**
 * Analyze issues and propose optimizations (called during dream cycle)
 */
export function analyzePromptHealth(): PromptOptimization[] {
    const optimizations: PromptOptimization[] = []
    const sections = parseSoulSections()

    // Find issues with frequency >= 3 (pattern, not one-off)
    const significantIssues = issues.filter(i => i.frequency >= 3)

    for (const issue of significantIssues) {
        const section = sections.find(s => s.header.includes(issue.section))
        if (!section) continue
        if (section.locked) {
            console.log(`[L24] 🔒 Section "${issue.section}" ist LOCKED — überspringe`)
            continue
        }

        let proposed = section.content
        let reason = ''

        switch (issue.category) {
            case 'verbosity':
                proposed = section.content + '\n⚠️ WICHTIG: Halte dich KURZ (max 3 Sätze bei einfachen Fragen).\n'
                reason = `${issue.frequency}x zu ausführlich in dieser Sektion`
                break
            case 'language':
                proposed = section.content + '\n⚠️ SPRACHE: Immer auf Deutsch antworten!\n'
                reason = `${issue.frequency}x falsche Sprache`
                break
            case 'hallucination':
                proposed = section.content + '\n⚠️ HALLUZINATION VERMEIDEN: Nur antworten was du sicher weißt. Bei Unsicherheit sag "Ich bin nicht sicher".\n'
                reason = `${issue.frequency}x Halluzination in dieser Sektion`
                break
            case 'tone':
                proposed = section.content + '\n⚠️ TON: Einfach und verständlich sprechen.\n'
                reason = `${issue.frequency}x falscher Ton`
                break
            default:
                continue
        }

        optimizations.push({
            timestamp: new Date().toISOString(),
            section: issue.section,
            original: section.content.trim(),
            proposed: proposed.trim(),
            reason,
            applied: false,
        })
    }

    if (optimizations.length > 0) {
        saveOptimizations(optimizations)
        console.log(`[L24] 📝 ${optimizations.length} Prompt-Optimierungen vorgeschlagen`)
    }

    return optimizations
}

/**
 * Apply a proposed optimization to SOUL.md
 * Only modifies UNLOCKED sections
 */
export function applyOptimization(opt: PromptOptimization): boolean {
    if (isSectionLocked(opt.section)) {
        console.log(`[L24] 🔒 Kann nicht anwenden — Section "${opt.section}" ist LOCKED`)
        return false
    }

    try {
        const content = readFileSync(SOUL_PATH, 'utf-8')
        if (!content.includes(opt.original)) {
            console.log(`[L24] ⚠️ Original-Text nicht in SOUL.md gefunden — überspringe`)
            return false
        }

        const newContent = content.replace(opt.original, opt.proposed)

        // Safety: max 5% change
        const changeRatio = Math.abs(newContent.length - content.length) / content.length
        if (changeRatio > 0.05) {
            console.log(`[L24] ⚠️ Änderung zu groß (${(changeRatio * 100).toFixed(1)}%) — überspringe`)
            return false
        }

        writeFileSync(SOUL_PATH, newContent)
        opt.applied = true
        console.log(`[L24] ✅ Optimierung angewendet: ${opt.reason}`)
        return true
    } catch (err) {
        console.log(`[L24] ⚠️ Fehler: ${err}`)
        return false
    }
}

// ============================================
// Persistence
// ============================================

function saveIssues(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'issues.json'), JSON.stringify(issues, null, 2))
    } catch { /* non-critical */ }
}

function saveOptimizations(opts: PromptOptimization[]): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'optimizations.json'), JSON.stringify(opts, null, 2))
    } catch { /* non-critical */ }
}

function loadIssues(): void {
    try {
        const path = join(DATA_DIR, 'issues.json')
        if (existsSync(path)) {
            issues = JSON.parse(readFileSync(path, 'utf-8'))
        }
    } catch { /* start fresh */ }
}

// ============================================
// Init
// ============================================

export function initPromptOptimizer(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    loadIssues()

    const sections = parseSoulSections()
    const lockedCount = sections.filter(s => s.locked).length
    console.log(`[L24] ✅ Initialized — ${sections.length} Sections (${lockedCount} locked), ${issues.length} tracked issues`)
}
