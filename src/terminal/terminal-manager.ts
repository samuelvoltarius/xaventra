/**
 * Nova Terminal Manager
 *
 * Terminal output formatting, ANSI colors, tables, themes.
 * Used for CLI output and TUI rendering.
 *
 * Inspired by OpenClaw's terminal/ (14 files: ANSI, tables, themes, stream-writer)
 */

// ============================================
// ANSI Color Codes
// ============================================

const isColorSupported = process.stdout.isTTY && !process.env.NO_COLOR

function ansi(code: string): string {
    return isColorSupported ? `\x1b[${code}m` : ''
}

export const colors = {
    reset: ansi('0'),
    bold: ansi('1'),
    dim: ansi('2'),
    italic: ansi('3'),
    underline: ansi('4'),

    // Foreground
    black: ansi('30'),
    red: ansi('31'),
    green: ansi('32'),
    yellow: ansi('33'),
    blue: ansi('34'),
    magenta: ansi('35'),
    cyan: ansi('36'),
    white: ansi('37'),
    gray: ansi('90'),

    // Bright
    brightRed: ansi('91'),
    brightGreen: ansi('92'),
    brightYellow: ansi('93'),
    brightBlue: ansi('94'),
    brightMagenta: ansi('95'),
    brightCyan: ansi('96'),
    brightWhite: ansi('97'),

    // Background
    bgRed: ansi('41'),
    bgGreen: ansi('42'),
    bgYellow: ansi('43'),
    bgBlue: ansi('44'),
    bgMagenta: ansi('45'),
    bgCyan: ansi('46'),
}

// ============================================
// Color Helper Functions
// ============================================

export function colorize(text: string, color: keyof typeof colors): string {
    return `${colors[color]}${text}${colors.reset}`
}

export function success(text: string): string {
    return colorize(`✅ ${text}`, 'green')
}

export function error(text: string): string {
    return colorize(`❌ ${text}`, 'red')
}

export function warning(text: string): string {
    return colorize(`⚠️ ${text}`, 'yellow')
}

export function info(text: string): string {
    return colorize(`ℹ️ ${text}`, 'cyan')
}

export function highlight(text: string): string {
    return colorize(text, 'brightCyan')
}

export function dim(text: string): string {
    return colorize(text, 'dim')
}

// ============================================
// Table Rendering (like OpenClaw's table.ts — 11KB)
// ============================================

export interface TableColumn {
    key: string
    header: string
    width?: number
    align?: 'left' | 'right' | 'center'
    color?: keyof typeof colors
}

export interface TableOptions {
    border?: boolean
    header?: boolean
    padding?: number
    maxWidth?: number
}

/**
 * Render data as a formatted ASCII table
 */
export function renderTable(
    data: Record<string, unknown>[],
    columns: TableColumn[],
    options: TableOptions = {},
): string {
    const { border = true, header = true, padding = 1 } = options
    const maxWidth = options.maxWidth || process.stdout.columns || 120

    // Calculate column widths
    const pad = ' '.repeat(padding)
    const widths = columns.map(col => {
        if (col.width) return col.width
        const headerLen = col.header.length
        const maxDataLen = Math.max(
            ...data.map(row => String(row[col.key] ?? '').length),
            0,
        )
        return Math.min(Math.max(headerLen, maxDataLen), 40)
    })

    // Adjust to fit maxWidth
    const totalBorder = border ? columns.length + 1 : 0
    const totalPadding = padding * 2 * columns.length
    const totalContent = widths.reduce((a, b) => a + b, 0)
    const total = totalContent + totalBorder + totalPadding

    if (total > maxWidth) {
        const excess = total - maxWidth
        const lastCol = widths.length - 1
        widths[lastCol] = Math.max(widths[lastCol] - excess, 10)
    }

    const lines: string[] = []

    // Border helpers
    const horizontalLine = border
        ? '┌' + widths.map(w => '─'.repeat(w + padding * 2)).join('┬') + '┐'
        : ''
    const separatorLine = border
        ? '├' + widths.map(w => '─'.repeat(w + padding * 2)).join('┼') + '┤'
        : ''
    const bottomLine = border
        ? '└' + widths.map(w => '─'.repeat(w + padding * 2)).join('┴') + '┘'
        : ''

    function formatCell(value: string, width: number, align: string = 'left'): string {
        const truncated = value.length > width ? value.slice(0, width - 1) + '…' : value
        switch (align) {
            case 'right':
                return truncated.padStart(width)
            case 'center':
                const leftPad = Math.floor((width - truncated.length) / 2)
                return truncated.padStart(leftPad + truncated.length).padEnd(width)
            default:
                return truncated.padEnd(width)
        }
    }

    function formatRow(values: string[]): string {
        const cells = values.map((val, i) => {
            const formatted = formatCell(val, widths[i], columns[i].align)
            const colored = columns[i].color ? colorize(formatted, columns[i].color!) : formatted
            return `${pad}${colored}${pad}`
        })

        return border ? `│${cells.join('│')}│` : cells.join(' ')
    }

    // Build table
    if (border) lines.push(horizontalLine)

    if (header) {
        const headerValues = columns.map(c => c.header)
        lines.push(formatRow(headerValues.map((h, i) =>
            colorize(formatCell(h, widths[i], columns[i].align), 'bold'),
        )))
        if (border) lines.push(separatorLine)
    }

    for (const row of data) {
        const values = columns.map(col => String(row[col.key] ?? ''))
        lines.push(formatRow(values))
    }

    if (border) lines.push(bottomLine)

    return lines.join('\n')
}

// ============================================
// Progress Line (like OpenClaw's progress-line.ts)
// ============================================

export function progressBar(current: number, total: number, width = 30, label?: string): string {
    const percentage = Math.min(Math.max(current / total, 0), 1)
    const filled = Math.round(width * percentage)
    const empty = width - filled
    const bar = colorize('█'.repeat(filled), 'green') + dim('░'.repeat(empty))
    const pct = `${Math.round(percentage * 100)}%`
    const labelStr = label ? ` ${label}` : ''
    return `${bar} ${pct}${labelStr}`
}

// ============================================
// Spinner (Compact)
// ============================================

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export class Spinner {
    private frame = 0
    private timer: ReturnType<typeof setInterval> | null = null
    private message: string

    constructor(message: string = 'Loading...') {
        this.message = message
    }

    start(): void {
        this.timer = setInterval(() => {
            const spinner = colorize(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length], 'cyan')
            process.stdout.write(`\r${spinner} ${this.message}`)
            this.frame++
        }, 80)
    }

    update(message: string): void {
        this.message = message
    }

    stop(finalMessage?: string): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        process.stdout.write(`\r${' '.repeat(this.message.length + 10)}\r`)
        if (finalMessage) {
            console.log(finalMessage)
        }
    }
}

// ============================================
// Themes (like OpenClaw's theme.ts)
// ============================================

export interface Theme {
    name: string
    primary: keyof typeof colors
    secondary: keyof typeof colors
    accent: keyof typeof colors
    success: keyof typeof colors
    error: keyof typeof colors
    warning: keyof typeof colors
    info: keyof typeof colors
    dim: keyof typeof colors
}

export const themes: Record<string, Theme> = {
    nova: {
        name: 'Nova',
        primary: 'brightCyan',
        secondary: 'brightMagenta',
        accent: 'brightYellow',
        success: 'brightGreen',
        error: 'brightRed',
        warning: 'yellow',
        info: 'cyan',
        dim: 'gray',
    },
    dark: {
        name: 'Dark',
        primary: 'blue',
        secondary: 'magenta',
        accent: 'yellow',
        success: 'green',
        error: 'red',
        warning: 'yellow',
        info: 'cyan',
        dim: 'gray',
    },
    minimal: {
        name: 'Minimal',
        primary: 'white',
        secondary: 'gray',
        accent: 'white',
        success: 'green',
        error: 'red',
        warning: 'yellow',
        info: 'white',
        dim: 'gray',
    },
}

let currentTheme: Theme = themes.nova

export function setTheme(name: string): void {
    if (themes[name]) {
        currentTheme = themes[name]
    }
}

export function getTheme(): Theme {
    return currentTheme
}

// ============================================
// Box Drawing
// ============================================

export function box(title: string, content: string, width = 60): string {
    const lines: string[] = []
    const innerWidth = width - 4

    lines.push(`╭${'─'.repeat(width - 2)}╮`)

    if (title) {
        const titlePad = innerWidth - title.length
        const leftPad = Math.floor(titlePad / 2)
        const rightPad = titlePad - leftPad
        lines.push(`│ ${' '.repeat(leftPad)}${colorize(title, 'bold')}${' '.repeat(rightPad)} │`)
        lines.push(`├${'─'.repeat(width - 2)}┤`)
    }

    const contentLines = content.split('\n')
    for (const line of contentLines) {
        const truncated = line.slice(0, innerWidth)
        lines.push(`│ ${truncated.padEnd(innerWidth)} │`)
    }

    lines.push(`╰${'─'.repeat(width - 2)}╯`)
    return lines.join('\n')
}

// ============================================
// Stream Writer (like OpenClaw's stream-writer.ts)
// ============================================

export class StreamWriter {
    private buffer = ''
    private lineCount = 0

    write(text: string): void {
        this.buffer += text
        const newLines = text.split('\n').length - 1
        this.lineCount += newLines
        process.stdout.write(text)
    }

    writeLine(text: string): void {
        this.write(text + '\n')
    }

    clear(): void {
        // Move cursor up and clear lines
        if (this.lineCount > 0) {
            process.stdout.write(`\x1b[${this.lineCount}A\x1b[0J`)
        }
        this.buffer = ''
        this.lineCount = 0
    }

    getBuffer(): string {
        return this.buffer
    }
}

export default {
    colors,
    colorize,
    success,
    error,
    warning,
    info,
    highlight,
    dim,
    renderTable,
    progressBar,
    Spinner,
    themes,
    setTheme,
    getTheme,
    box,
    StreamWriter,
}
