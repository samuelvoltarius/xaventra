// Pure HUD logic (no SDK import) — the screen text and what a gesture means.

export interface HudCard { id: string; titel: string; text: string; wirkung: string; antworten: Array<'ja' | 'nein'> }
export interface HudFeed { version: string; status: string; cards: HudCard[] }

export interface HudState {
  feed: HudFeed | null
  index: number
  /** Card id waiting for the confirming second tap (physical/outward cards). */
  confirm: string | null
  message: string
  online: boolean
}

export type Gesture = 'tap' | 'double' | 'up' | 'down'
export type HudAction =
  | { kind: 'answer'; cardId: string; answer: 'ja' | 'nein' }
  | { kind: 'confirm'; cardId: string }
  | { kind: 'move'; index: number }
  | { kind: 'exit' }
  | { kind: 'none' }

const WIDTH = 44

function wrap(text: string, lines: number): string[] {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ')
  const out: string[] = []
  let line = ''
  for (const word of words) {
    if ((line + ' ' + word).trim().length > WIDTH) { out.push(line); line = word } else line = (line + ' ' + word).trim()
    if (out.length >= lines) break
  }
  if (line && out.length < lines) out.push(line)
  const used = out.join(' ').length
  if (used < String(text || '').replace(/\s+/g, ' ').trim().length && out.length) out[out.length - 1] = out[out.length - 1].slice(0, WIDTH - 1) + '…'
  return out
}

export function currentCard(state: HudState): HudCard | null {
  const cards = state.feed?.cards || []
  return cards.length ? cards[Math.min(state.index, cards.length - 1)] : null
}

export function renderHud(state: HudState, clock: string): string {
  const head = `Xaventra ${state.online ? '·' : '(offline)'} ${clock}`
  if (!state.feed) return [head, '', state.message || 'Verbinde …', '', 'Adresse + Token am Telefon eintragen.'].join('\n')
  const lines = [head, ...wrap(`> ${state.feed.status}`, 2), '']
  const card = currentCard(state)
  if (!card) {
    lines.push('Keine offenen Fragen.', '', ...wrap(state.message, 1), '2x Tap = beenden')
    return lines.join('\n')
  }
  const total = state.feed.cards.length
  lines.push(`Frage ${Math.min(state.index, total - 1) + 1}/${total}${card.wirkung !== 'intern' ? ' (' + card.wirkung + ')' : ''}`)
  lines.push(...wrap(card.titel, 2), ...wrap(card.text, 2), '')
  if (state.confirm === card.id) lines.push('Nochmal tippen = JA bestätigen')
  else if (state.message) lines.push(...wrap(state.message, 1))
  lines.push(total > 1 ? 'Tap Ja · 2x Tap Nein · Wischen weiter' : 'Tap = Ja · 2x Tap = Nein')
  return lines.join('\n')
}

/** Tap = Ja (physical/outward cards need a second tap), double tap = Nein (no card: exit), swipe = next card. */
export function decide(state: HudState, gesture: Gesture): HudAction {
  const card = currentCard(state)
  const total = state.feed?.cards.length || 0
  if (gesture === 'up' || gesture === 'down') {
    if (total < 2) return { kind: 'none' }
    const step = gesture === 'down' ? 1 : -1
    return { kind: 'move', index: (state.index + step + total) % total }
  }
  if (gesture === 'double') return card ? { kind: 'answer', cardId: card.id, answer: 'nein' } : { kind: 'exit' }
  if (!card) return { kind: 'none' }
  if (card.wirkung !== 'intern' && state.confirm !== card.id) return { kind: 'confirm', cardId: card.id }
  return { kind: 'answer', cardId: card.id, answer: 'ja' }
}
