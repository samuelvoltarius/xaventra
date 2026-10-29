/**
 * 2.90.x „Freigaben merken“ over the real entry (only the model is scripted; fake Home
 * Assistant on example.com). Alfred 29.10.: „Ich lege es pro Gerät fest: Bei jeder Freigabe
 * gibt es einen Knopf ‚merken‘.“
 *   - /freigabe in Telegram carries „📌 merken“; the press stores exactly (tool + target);
 *   - the next call of exactly that target runs without a code and the answer says so;
 *   - /freigaben widerruf <id> → the code is needed again;
 *   - Nie-Liste and the fixed limits (locks, print, Auto …) → no button, not rememberable.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness, type EnvironmentRoute } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 120_000

const PLUG = 'switch.k1_max_steckdose'
const haConfig = { homeassistant: { url: 'http://ha.example.com:8123', token: 'fake-token-for-tests' } }
function haRoutes(calls: string[]): EnvironmentRoute[] {
    return [
        { match: /^http:\/\/ha\.example\.com:8123\/api\/services\//, respond: url => { calls.push(url); return { json: [{ entity_id: PLUG, state: 'on' }] } } },
        { match: /^http:\/\/ha\.example\.com:8123\/api\/states$/, respond: () => ({ json: [{ entity_id: PLUG, state: 'off', attributes: { friendly_name: 'K1 Max Steckdose' } }] }) },
    ]
}

/** Presses an inline button exactly as Telegram delivers it (callback_query → handleFeedback). */
async function press(harness: E2EHarness, data: string, from = OWNER_TELEGRAM_ID): Promise<string[]> {
    const tg = harness.state.channels.telegram
    const answers: string[] = []
    tg.config.verifyAuthority = async () => true
    tg.bot = {
        answerCallbackQuery: async (_id: string, options: { text?: string }) => { answers.push(String(options?.text || '')) },
        editMessageReplyMarkup: async () => undefined,
        sendMessage: async (_chat: string, text: string) => { answers.push(String(text)) },
    }
    await tg.handleFeedback({ id: 'q-1', data, from: { id: Number(from) }, message: { chat: { id: Number(from), type: 'private' }, message_id: 7 } })
    return answers
}

const mergeButton = (buttons: Array<{ keyboard: unknown }>) =>
    buttons.flatMap(item => (item.keyboard as Array<Array<{ text: string; callback_data: string }>>).flat()).find(button => /merken/.test(button.text))

const switchOn = [{ tool: 'hass_turn_on', args: { entity_id: PLUG } }, { text: 'Die Steckdose ist an.' }]
const ASK = `Schalte die Home-Assistant-Steckdose ${PLUG} ein`

describe('2.90.x: Freigaben merken', () => {
    it('remembered → the next call runs without a code and says so; revoked → the code is needed again', async () => {
        const calls: string[] = []
        h = await createE2EHarness({ config: haConfig, routes: haRoutes(calls) })

        // Without anything remembered the switch stays off (one-time code needed).
        const before = await h.telegram(ASK, switchOn)
        expect(before.offeredTools).toContain('hass_turn_on')
        expect(calls).toHaveLength(0)

        const issued = await h.telegram(`/freigabe hass_turn_on ${PLUG}`)
        const button = mergeButton(issued.buttons)
        expect(button?.callback_data).toMatch(/^fm:[a-f0-9]{16}$/)
        expect(issued.buttons[0]?.text).toContain(`tool:hass_turn_on:${PLUG}`)

        const pressed = await press(h, button!.callback_data)
        expect(pressed.join('\n')).toContain(`Gemerkt: tool:hass_turn_on:${PLUG}`)
        // Single use: a second press of the same button stores nothing new.
        expect((await press(h, button!.callback_data)).join('\n')).toMatch(/abgelaufen/)

        const listed = await h.telegram('/freigaben')
        const id = /\[(f-[a-f0-9]{8})\] tool:hass_turn_on:switch\.k1_max_steckdose/.exec(listed.final)?.[1]
        expect(id).toBeTruthy()

        const after = await h.telegram(ASK, switchOn)
        expect(after.executedTools).toContain('hass_turn_on')
        expect(calls).toEqual(['http://ha.example.com:8123/api/services/switch/turn_on'])
        expect(after.final).toContain(`📌 Gemerkte Freigabe genutzt: tool:hass_turn_on:${PLUG} [${id}]`)
        expect((await h.telegram('/freigaben')).final).toMatch(/1× genutzt/)

        // Only exactly this target: another entity of the same tool still needs a code.
        await h.telegram('Schalte switch.andere_steckdose ein', [{ tool: 'hass_turn_on', args: { entity_id: 'switch.andere_steckdose' } }, { text: 'ok' }])
        expect(calls).toHaveLength(1)

        expect((await h.telegram(`/freigaben widerruf ${id}`)).final).toContain('Widerrufen')
        const revoked = await h.telegram(ASK, switchOn)
        expect(revoked.final).not.toContain('Gemerkte Freigabe genutzt')
        expect(calls).toHaveLength(1)
        expect((await h.telegram('/freigaben')).final).toMatch(/Keine gemerkten Freigaben/)
    }, T)

    it('a stranger cannot press the owner\'s button', async () => {
        h = await createE2EHarness({ config: haConfig, routes: haRoutes([]) })
        const issued = await h.telegram(`/freigabe hass_turn_on ${PLUG}`)
        const button = mergeButton(issued.buttons)
        expect(button).toBeTruthy()
        const answers = await press(h, button!.callback_data, '700000999')
        expect(answers.join('\n')).not.toContain('Gemerkt')
        expect((await h.telegram('/freigaben')).final).toMatch(/Keine gemerkten Freigaben/)
    }, T)

    it.each([
        ['hass_turn_on', 'lock.haustuer'],
        ['hass_turn_on', 'cover.garagentor'],
        ['hass_turn_on', 'alarm_control_panel.haus'],
        ['hass_turn_on', 'switch.byd_dolphin_klima'],
        ['hass_service', 'switch.turn_on:switch.k1_max_steckdose'],
        ['printer_start', 'benchy.gcode'],
        ['send_telegram_message', '12345'],
        ['cluster_test_pod', 'alpine-test'],
        ['execute_python', '#0123456789ab'],
    ])('never rememberable: %s %s → no button, /freigabe merken refused', async (tool, detail) => {
        h = await createE2EHarness({ config: haConfig, routes: haRoutes([]) })
        const issued = await h.telegram(`/freigabe ${tool} ${detail}`)
        expect(mergeButton(issued.buttons)).toBeUndefined()
        expect(issued.final).toMatch(/Nicht merkbar/)
        expect((await h.telegram(`/freigabe merken ${tool} ${detail}`)).final).toMatch(/Nicht merkbar/)
        expect((await h.telegram('/freigaben')).final).toMatch(/Keine gemerkten Freigaben/)
    }, T)

    it('Desktop: the text form remembers too, and only the owner sees /freigaben', async () => {
        const calls: string[] = []
        h = await createE2EHarness({ config: haConfig, routes: haRoutes(calls) })
        const issued = await h.desktop(`/freigabe hass_turn_on ${PLUG}`)
        expect(issued.final).toContain(`/freigabe merken hass_turn_on ${PLUG}`)
        expect((await h.desktop(`/freigabe merken hass_turn_on ${PLUG}`)).final).toContain('📌 Gemerkt')
        const stranger = await h.telegram('/freigaben', [], { from: '700000999' })
        expect(stranger.final).not.toContain(PLUG)
    }, T)
})
