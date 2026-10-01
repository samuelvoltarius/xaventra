/**
 * Rules first: importance → delivery hint for a thought.
 *
 * Same semantics as ProactiveMessenger (src/core/proactive.ts): quiet hours
 * wrap midnight, urgent passes, a daily budget caps notifications. This module
 * only MARKS a thought (`delivery`); actual delivery stays with the governed
 * proactive path that the integration attaches to the ThoughtSink.
 */

import type { ProactivePolicy } from '../core/proactive.js'
import type { Importance, ThoughtDelivery } from './ports.js'

export type SensingNotifyPolicy = Pick<ProactivePolicy, 'quietHoursStart' | 'quietHoursEnd' | 'dailyBudget'> & { timezone: string }

export const DEFAULT_NOTIFY_POLICY: SensingNotifyPolicy = Object.freeze({ quietHoursStart: 22, quietHoursEnd: 7, dailyBudget: 10, timezone: 'Europe/Vienna' })

export function localHour(nowMs: number, timezone: string): number {
    try {
        const hour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(new Date(nowMs))
        const n = Number(hour)
        if (Number.isFinite(n)) return n % 24
    } catch { /* invalid timezone → local clock */ }
    return new Date(nowMs).getHours()
}

export function localDay(nowMs: number, timezone: string): string {
    try {
        return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone }).format(new Date(nowMs))
    } catch { return new Date(nowMs).toISOString().slice(0, 10) }
}

export function isQuietHour(hour: number, start: number, end: number): boolean {
    if (start === end) return false
    return start > end ? hour >= start || hour < end : hour >= start && hour < end
}

export interface NotifyCounter { day: string; count: number }

/** Decides the delivery hint and advances the counter when it says notify. */
export function decideDelivery(importance: Importance, policy: SensingNotifyPolicy, counter: NotifyCounter, nowMs: number): { delivery: ThoughtDelivery; counter: NotifyCounter } {
    const day = localDay(nowMs, policy.timezone)
    const current = counter.day === day ? counter : { day, count: 0 }
    if (importance === 'niedrig') return { delivery: { notify: false, urgent: false, reason: 'nur-protokoll' }, counter: current }
    if (importance === 'dringend') return { delivery: { notify: true, urgent: true, reason: 'ok' }, counter: { day, count: current.count + 1 } }
    if (isQuietHour(localHour(nowMs, policy.timezone), policy.quietHoursStart, policy.quietHoursEnd)) {
        return { delivery: { notify: false, urgent: false, reason: 'ruhezeit' }, counter: current }
    }
    if (current.count >= policy.dailyBudget) return { delivery: { notify: false, urgent: false, reason: 'tageslimit' }, counter: current }
    return { delivery: { notify: true, urgent: false, reason: 'ok' }, counter: { day, count: current.count + 1 } }
}
