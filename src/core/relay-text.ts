/**
 * The Quiet-Hub relay appends a style note to the question, e.g.
 * „(Antworte knapp auf Deutsch, ohne Markdown.)“. The note is for the model;
 * it is not part of what the owner asked. Everything that reads the question
 * itself (/freigabe, profile and clock answers, topic threads, routing) reads
 * it through this one function — live the note became an approval detail, a
 * failed fast path and a thread named „Antworte Deutsch“.
 *
 * Only a trailing parenthesis that is such a note goes; the owner's own
 * brackets („(kurz vor Salzburg)“, „(in Euro)“) stay.
 */
const STYLE_NOTE = /\s*\((?:antworte\b[^()]*\b(?:knapp|kurz|deutsch|markdown)\b|[^()]*\bohne markdown\b)[^()]*\)\s*$/iu

export function relayQuestionText(input: string): string {
    return String(input ?? '').replace(STYLE_NOTE, '')
}
