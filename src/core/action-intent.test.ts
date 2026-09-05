import { describe, expect, it } from 'vitest'
import { detectActionIntent, honestNoToolResponse, responseClaimsCompletedAction, toolProvidesActionEvidence } from './action-intent.js'

describe('action intent evidence gate', () => {
    it('requires tools for screenshots and live system state', () => {
        expect(detectActionIntent('Kannst du mir einen Screenshot vom Display senden?')).toEqual({ requiresTool: true, kind: 'screenshot' })
        expect(detectActionIntent('kannst du einen screnn shot machen').kind).toBe('screenshot')
        expect(detectActionIntent('Welche Programme sind gerade offen?')).toEqual({ requiresTool: true, kind: 'system-state' })
        expect(detectActionIntent('Wie spät ist es?').requiresTool).toBe(true)
        expect(detectActionIntent('Welche Modelle laufen aktuell auf dem Spark?')).toEqual({ requiresTool: true, kind: 'system-state' })
        expect(detectActionIntent('Wo läuft der Main?')).toEqual({ requiresTool: true, kind: 'system-state' })
        expect(detectActionIntent('Zeige die Nodes, die online sind.')).toEqual({ requiresTool: true, kind: 'system-state' })
    })

    it('requires a successful tool for typo-tolerant image creation requests', () => {
        expect(detectActionIntent('erstelll mir ein bild von salzburg')).toEqual({
            requiresTool: true,
            kind: 'image-generation',
        })
    })

    it('treats inflected German installation requests as device actions', () => {
        expect(detectActionIntent('Installiere Codex auf dem aktuellen Main')).toEqual({
            requiresTool: true,
            kind: 'device-action',
        })
    })

    it('treats explicit tool execution and replay requests as actions', () => {
        expect(detectActionIntent('Wiederhole denselben Toolaufruf ohne doppelte Wirkung.')).toEqual({
            requiresTool: true,
            kind: 'generic-action',
        })
        expect(detectActionIntent('Führe den Werkzeugaufruf aus.').requiresTool).toBe(true)
    })

    it('routes natural project and workspace questions through file tools', () => {
        expect(detectActionIntent('Schau dir package.json in meinem Projekt an').kind).toBe('file')
        expect(detectActionIntent('Analysiere bitte den verbundenen Workspace').kind).toBe('file')
        expect(detectActionIntent('Suche im Repo nach dem Model Router')).toEqual({ requiresTool: true, kind: 'file' })
    })

    it('does not treat discovery or skill planning as action fulfillment', () => {
        expect(toolProvidesActionEvidence('nova_capabilities')).toBe(false)
        expect(toolProvidesActionEvidence('resolve_capability')).toBe(false)
        expect(toolProvidesActionEvidence('build_skill')).toBe(false)
        expect(toolProvidesActionEvidence('load_skill_pack')).toBe(false)
        expect(toolProvidesActionEvidence('self_setup_plan')).toBe(false)
        expect(toolProvidesActionEvidence('self_setup_research')).toBe(false)
        expect(toolProvidesActionEvidence('generate_image')).toBe(true)
        expect(toolProvidesActionEvidence('send_file')).toBe(true)
    })

    it('does not force tools for ordinary conversation', () => {
        expect(detectActionIntent('Erkläre mir, warum der Himmel blau ist.')).toEqual({ requiresTool: false, kind: 'none' })
    })

    it('detects fabricated completion claims', () => {
        expect(responseClaimsCompletedAction('Der Screenshot wurde soeben gesendet.')).toBe(true)
        expect(responseClaimsCompletedAction('Ich habe die Datei gerade erstellt.')).toBe(true)
        expect(responseClaimsCompletedAction('Dafür müsste ich zuerst einen Screenshot erstellen.')).toBe(false)
    })

    it('returns an explicit non-success response without evidence', () => {
        expect(honestNoToolResponse('screenshot')).toContain('keine Bilddatei übertragen')
        expect(honestNoToolResponse('device-action')).toContain('kein passendes Tool')
    })
})
