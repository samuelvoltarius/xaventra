/**
 * Nova - Terminal Theme
 * 
 * Console color utilities for CLI output.
 */

const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
}

export const theme = {
    success: (text: string) => `${colors.green}${text}${colors.reset}`,
    warn: (text: string) => `${colors.yellow}${text}${colors.reset}`,
    error: (text: string) => `${colors.red}${text}${colors.reset}`,
    info: (text: string) => `${colors.blue}${text}${colors.reset}`,
    muted: (text: string) => `${colors.gray}${text}${colors.reset}`,
    bold: (text: string) => `${colors.bold}${text}${colors.reset}`,
    cyan: (text: string) => `${colors.cyan}${text}${colors.reset}`,
    magenta: (text: string) => `${colors.magenta}${text}${colors.reset}`,
    accent: (text: string) => `${colors.cyan}${text}${colors.reset}`,
    heading: (text: string) => `${colors.bold}${colors.cyan}${text}${colors.reset}`,
}

export const isRich = () => !process.env.NO_COLOR

export default theme
