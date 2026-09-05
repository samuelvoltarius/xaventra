/**
 * Nova - Desktop Controller
 * 
 * Native mouse and keyboard control for desktop automation.
 * Uses @nut-tree/nut-js for cross-platform support.
 * 
 * Install: npm install @nut-tree/nut-js
 */

// ============================================
// Types
// ============================================

export interface Point {
    x: number
    y: number
}

export interface DesktopConfig {
    mouseSpeed: number      // Pixels per second
    typeDelay: number       // Ms between keystrokes
    autoHighlight: boolean  // Highlight click positions
}

// ============================================
// Default Config
// ============================================

const DEFAULT_CONFIG: DesktopConfig = {
    mouseSpeed: 1000,
    typeDelay: 50,
    autoHighlight: false,
}

// ============================================
// Desktop Controller
// ============================================

export class DesktopController {
    private config: DesktopConfig
    private nutLoaded = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private nut: any = null

    constructor(config: Partial<DesktopConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }
    }

    // ============================================
    // Initialization
    // ============================================

    private async ensureNut(): Promise<void> {
        if (this.nutLoaded) return

        try {
            // @ts-expect-error - nut-js may not be installed
            const nutjs = await import('@nut-tree/nut-js')
            this.nut = nutjs
            this.nut.mouse.config.mouseSpeed = this.config.mouseSpeed
            this.nut.keyboard.config.autoDelayMs = this.config.typeDelay
            this.nutLoaded = true
            console.log('[Desktop] Initialized')
        } catch {
            throw new Error('Desktop control requires @nut-tree/nut-js. Run: npm install @nut-tree/nut-js')
        }
    }

    // ============================================
    // Mouse Control
    // ============================================

    /**
     * Move mouse to absolute position.
     */
    async moveTo(x: number, y: number): Promise<void> {
        await this.ensureNut()
        await this.nut.mouse.move([{ x, y }])
        console.log(`[Desktop] Mouse → (${x}, ${y})`)
    }

    /**
     * Move mouse relative to current position.
     */
    async moveBy(dx: number, dy: number): Promise<void> {
        await this.ensureNut()
        const pos = await this.nut.mouse.getPosition()
        await this.nut.mouse.move([{ x: pos.x + dx, y: pos.y + dy }])
    }

    /**
     * Get current mouse position.
     */
    async getPosition(): Promise<Point> {
        await this.ensureNut()
        return this.nut.mouse.getPosition()
    }

    /**
     * Left click at current position.
     */
    async click(): Promise<void> {
        await this.ensureNut()
        await this.nut.mouse.leftClick()
        console.log('[Desktop] Click')
    }

    /**
     * Left click at specific position.
     */
    async clickAt(x: number, y: number): Promise<void> {
        await this.moveTo(x, y)
        await this.click()
    }

    /**
     * Double click.
     */
    async doubleClick(): Promise<void> {
        await this.ensureNut()
        await this.nut.mouse.doubleClick()
        console.log('[Desktop] Double Click')
    }

    /**
     * Right click.
     */
    async rightClick(): Promise<void> {
        await this.ensureNut()
        await this.nut.mouse.rightClick()
        console.log('[Desktop] Right Click')
    }

    /**
     * Right click at position.
     */
    async rightClickAt(x: number, y: number): Promise<void> {
        await this.moveTo(x, y)
        await this.rightClick()
    }

    /**
     * Scroll up or down.
     */
    async scroll(amount: number): Promise<void> {
        await this.ensureNut()
        if (amount > 0) {
            await this.nut.mouse.scrollUp(amount)
        } else {
            await this.nut.mouse.scrollDown(Math.abs(amount))
        }
        console.log(`[Desktop] Scroll ${amount > 0 ? 'up' : 'down'} ${Math.abs(amount)}`)
    }

    /**
     * Drag from one position to another.
     */
    async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
        await this.ensureNut()
        await this.nut.mouse.move([{ x: fromX, y: fromY }])
        await this.nut.mouse.pressButton(0) // Left button
        await this.nut.mouse.move([{ x: toX, y: toY }])
        await this.nut.mouse.releaseButton(0)
        console.log(`[Desktop] Drag (${fromX},${fromY}) → (${toX},${toY})`)
    }

    // ============================================
    // Keyboard Control
    // ============================================

    /**
     * Type text.
     */
    async type(text: string): Promise<void> {
        await this.ensureNut()
        await this.nut.keyboard.type(text)
        console.log(`[Desktop] Type: ${text.slice(0, 30)}...`)
    }

    /**
     * Press a single key.
     */
    async pressKey(key: string): Promise<void> {
        await this.ensureNut()
        const keyCode = this.mapKey(key)
        await this.nut.keyboard.pressKey(keyCode)
        await this.nut.keyboard.releaseKey(keyCode)
        console.log(`[Desktop] Key: ${key}`)
    }

    /**
     * Press a keyboard shortcut.
     */
    async shortcut(...keys: string[]): Promise<void> {
        await this.ensureNut()
        const keyCodes = keys.map(k => this.mapKey(k))

        // Press all keys
        for (const key of keyCodes) {
            await this.nut.keyboard.pressKey(key)
        }

        // Release in reverse order
        for (const key of keyCodes.reverse()) {
            await this.nut.keyboard.releaseKey(key)
        }

        console.log(`[Desktop] Shortcut: ${keys.join('+')}`)
    }

    /**
     * Common shortcuts.
     */
    async copy(): Promise<void> {
        await this.shortcut('ctrl', 'c')
    }

    async paste(): Promise<void> {
        await this.shortcut('ctrl', 'v')
    }

    async cut(): Promise<void> {
        await this.shortcut('ctrl', 'x')
    }

    async undo(): Promise<void> {
        await this.shortcut('ctrl', 'z')
    }

    async redo(): Promise<void> {
        await this.shortcut('ctrl', 'y')
    }

    async selectAll(): Promise<void> {
        await this.shortcut('ctrl', 'a')
    }

    async save(): Promise<void> {
        await this.shortcut('ctrl', 's')
    }

    async enter(): Promise<void> {
        await this.pressKey('enter')
    }

    async escape(): Promise<void> {
        await this.pressKey('escape')
    }

    async tab(): Promise<void> {
        await this.pressKey('tab')
    }

    // ============================================
    // Screen
    // ============================================

    /**
     * Get screen size.
     */
    async getScreenSize(): Promise<{ width: number; height: number }> {
        await this.ensureNut()
        const screen = await this.nut.screen.width()
        const height = await this.nut.screen.height()
        return { width: screen, height }
    }

    /**
     * Take screenshot of entire screen.
     */
    async screenshot(path: string): Promise<string> {
        await this.ensureNut()
        await this.nut.screen.capture(path)
        console.log(`[Desktop] Screenshot: ${path}`)
        return path
    }

    // ============================================
    // Key Mapping
    // ============================================

    private mapKey(key: string): number {
        // This would use nut-js Key enum
        // For now, return a simple mapping
        const keyMap: Record<string, number> = {
            'enter': 0x0D,
            'escape': 0x1B,
            'tab': 0x09,
            'backspace': 0x08,
            'delete': 0x2E,
            'space': 0x20,
            'ctrl': 0x11,
            'alt': 0x12,
            'shift': 0x10,
            'win': 0x5B,
            'cmd': 0x5B,
            'up': 0x26,
            'down': 0x28,
            'left': 0x25,
            'right': 0x27,
            'home': 0x24,
            'end': 0x23,
            'pageup': 0x21,
            'pagedown': 0x22,
            'f1': 0x70,
            'f2': 0x71,
            'f3': 0x72,
            'f4': 0x73,
            'f5': 0x74,
            'f6': 0x75,
            'f7': 0x76,
            'f8': 0x77,
            'f9': 0x78,
            'f10': 0x79,
            'f11': 0x7A,
            'f12': 0x7B,
        }

        const lower = key.toLowerCase()
        if (keyMap[lower]) return keyMap[lower]

        // Single character - return char code
        if (key.length === 1) {
            return key.toUpperCase().charCodeAt(0)
        }

        return 0
    }

    // ============================================
    // Utilities
    // ============================================

    /**
     * Wait for specified milliseconds.
     */
    async wait(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Check if nut-js is available.
     */
    async isAvailable(): Promise<boolean> {
        try {
            await this.ensureNut()
            return true
        } catch {
            return false
        }
    }
}

// ============================================
// Factory
// ============================================

let desktopInstance: DesktopController | null = null

export function getDesktopController(): DesktopController {
    if (!desktopInstance) {
        desktopInstance = new DesktopController()
    }
    return desktopInstance
}

export function createDesktopController(config?: Partial<DesktopConfig>): DesktopController {
    return new DesktopController(config)
}

export default { DesktopController, getDesktopController, createDesktopController }
