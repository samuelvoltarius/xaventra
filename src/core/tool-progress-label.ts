/**
 * 2.89: short human status for the progress side channel. Never an internal
 * tool name: unknown tools get a neutral sentence.
 */
const LABELS: Array<[RegExp, string]> = [
    [/(?<!kg|code|self)_search|^search$|searx|tavily|duckduckgo|web_research|news_/, 'suche im Web …'],
    [/browser|fetch_url|web_fetch|read_url|scrape/, 'lese eine Webseite …'],
    [/mesh|node|environment_inventory|scan_now|health|status/, 'prüfe Knoten und Systeme …'],
    [/hass|home_assistant|light|climate|switch|device/, 'frage dein Zuhause ab …'],
    [/remind|calendar|schedule|termin|plan/, 'schaue in deine Erinnerungen und Termine …'],
    [/screenshot|screen|vision|image/, 'sehe mir den Bildschirm an …'],
    [/read_file|list_dir|find_files|code_search|file/, 'lese Dateien …'],
    [/write_file|edit_file|create_file/, 'schreibe eine Datei …'],
    [/memory|remember|recall|kg_|knowledge/, 'schaue in mein Gedächtnis …'],
    [/email|mail|telegram|send_message|notify/, 'bereite eine Nachricht vor …'],
    [/spawn|agent|team/, 'bitte einen Helfer dazu …'],
]

export const THINKING_LABEL = 'denke nach …'

export function toolProgressLabel(toolName: string): string {
    const name = String(toolName || '').toLowerCase()
    for (const [pattern, label] of LABELS) if (pattern.test(name)) return label
    return 'führe einen Arbeitsschritt aus …'
}

const KNOWN = new Set<string>([THINKING_LABEL, 'führe einen Arbeitsschritt aus …', ...LABELS.map(([, label]) => label)])

/** True for the plain progress labels above (they are status, never a notice worth keeping). */
export function isToolProgressLabel(status: string): boolean {
    return KNOWN.has(String(status || '').trim())
}
