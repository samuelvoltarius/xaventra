/**
 * Nova - Global Utilities
 * 
 * Shared utilities and settings for Nova.
 */

import { theme } from './terminal/theme.js'

// ============================================
// Verbose Mode
// ============================================

let globalVerbose = false
let globalYes = false

export function setVerbose(v: boolean): void {
  globalVerbose = v
}

export function isVerbose(): boolean {
  return globalVerbose
}

export function shouldLogVerbose(): boolean {
  return globalVerbose || process.env.NOVA_DEBUG === 'true'
}

export function logVerbose(message: string): void {
  if (!shouldLogVerbose()) return
  console.log(theme.muted(`[verbose] ${message}`))
}

export function logVerboseConsole(message: string): void {
  if (!globalVerbose) return
  console.log(theme.muted(message))
}

// ============================================
// Yes Mode (Auto-confirm)
// ============================================

export function setYes(v: boolean): void {
  globalYes = v
}

export function isYes(): boolean {
  return globalYes
}

// ============================================
// Theme Exports
// ============================================

export const success = theme.success
export const warn = theme.warn
export const info = theme.info
export const danger = theme.error
export const muted = theme.muted

// ============================================
// Debug Logging
// ============================================

export function logDebug(message: string, ...args: unknown[]): void {
  if (process.env.NOVA_DEBUG === 'true') {
    console.log(theme.muted(`[debug] ${message}`), ...args)
  }
}

export function logError(message: string, error?: unknown): void {
  console.error(theme.error(`[error] ${message}`), error ?? '')
}

export function logWarn(message: string): void {
  console.warn(theme.warn(`[warn] ${message}`))
}

export function logInfo(message: string): void {
  console.log(theme.info(`[info] ${message}`))
}

export default {
  setVerbose,
  isVerbose,
  shouldLogVerbose,
  logVerbose,
  logVerboseConsole,
  setYes,
  isYes,
  success,
  warn,
  info,
  danger,
  muted,
  logDebug,
  logError,
  logWarn,
  logInfo,
}
