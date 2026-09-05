/**
 * LLM-assisted front end for Nova Studio Skill Forge.
 *
 * Generation is not installation. The result enters the same governed Forge
 * used by build_skill and remains inert until its evidence gates pass.
 */
import { resolveModelId } from '../core/model-resolver.js'
import { createSkillProposal, getSkillProposals, type SkillProposal } from './skill-builder.js'
import { deleteCustomTool, loadCustomTools } from './self-extension.js'

async function generateSkillCode(skillName: string, skillDescription: string, examples?: string): Promise<{ code: string; parameters: SkillProposal['parameters'] } | null> {
    try {
        const prompt = `Erzeuge einen inerten JavaScript-Skill-Entwurf für Nova Studio.
Name: ${skillName}
Beschreibung: ${skillDescription}
${examples ? `Beispiele: ${examples}` : ''}

Regeln: Nur params, JSON, Date, Math, String, Number, Array und Object. Kein Netzwerk,
kein Dateisystem, kein process, require, import, eval oder Function. Keine Dependencies.
Antworte ausschließlich als JSON {"code":"...","parameters":[...]}.`
        const modelId = await resolveModelId('small')
        const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
        const response = await (await createNovaLLMClient({ model: modelId })).complete([{ role: 'user', content: prompt }])
        const match = response.content?.match(/\{[\s\S]*\}/)
        if (!match) return null
        const parsed = JSON.parse(match[0])
        return { code: String(parsed.code || ''), parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [] }
    } catch (error) {
        console.log(`[SkillSynthesis] proposal generation failed: ${error}`)
        return null
    }
}

export async function synthesizeSkill(name: string, description: string, userId: string, examples?: string): Promise<{ success: boolean; proposal?: SkillProposal; error?: string }> {
    const generated = await generateSkillCode(name, description, examples)
    if (!generated) return { success: false, error: 'LLM konnte keinen gültigen Entwurf erzeugen' }
    try {
        const proposal = createSkillProposal({ ownerId: userId, name, description, why: examples || 'Explizit angeforderte neue Fähigkeit', code: generated.code, parameters: generated.parameters })
        return { success: true, proposal }
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
}

export const skillSynthesisTool = {
    name: 'create_skill',
    description: 'Erzeugt einen Skill-Entwurf und legt ihn in Nova Studio Skill Forge ab. Keine direkte Installation oder Aktivierung.',
    category: 'learning' as const,
    parameters: [
        { name: 'name', type: 'string' as const, description: 'Name des Skill-Entwurfs', required: true },
        { name: 'description', type: 'string' as const, description: 'Was der Skill tun soll', required: true },
        { name: 'examples', type: 'string' as const, description: 'Beispiele und erwartete Ergebnisse', required: false },
    ],
    handler: async (params: { name: string; description: string; examples?: string }) => {
        const result = await synthesizeSkill(params.name, params.description, 'nova-self', params.examples)
        if (!result.success || !result.proposal) return { message: `❌ Skill-Entwurf fehlgeschlagen: ${result.error}` }
        return { message: `🧪 **${result.proposal.name}** wurde als Forge-Vorschlag gespeichert.\n\nStatus: proposed\nHash: ${result.proposal.codeHash.slice(0, 16)}…\nNoch nicht ausführbar; Sandbox, Benchmark, Canary und Owner-Freigabe fehlen.` }
    },
}

export const listSkillsTool = {
    name: 'list_skills',
    description: 'Zeigt aktive Legacy-Custom-Tools und inerte Nova-Studio-Forge-Vorschläge.',
    category: 'learning' as const,
    parameters: [],
    handler: async () => {
        const active = loadCustomTools()
        const proposals = getSkillProposals(100)
        if (!active.length && !proposals.length) return { message: '📭 Noch keine Skills oder Forge-Vorschläge.' }
        const staged = proposals.map(item => `• **${item.name}** — ${item.status} (${item.codeHash.slice(0, 10)}…)`).join('\n')
        const legacy = active.map(item => `• **${item.name}** — legacy active`).join('\n')
        return { message: `🧪 **Nova Studio Skill Forge**\n\n${staged || 'Keine Vorschläge'}${legacy ? `\n\nLegacy:\n${legacy}` : ''}` }
    },
}

export const deleteSkillTool = {
    name: 'delete_skill',
    description: 'Entfernt ein bereits vorhandenes Legacy-Custom-Tool. Forge-Vorschläge werden über den Reifungsprozess abgelehnt.',
    category: 'learning' as const,
    parameters: [{ name: 'name', type: 'string' as const, description: 'Name des Legacy-Skills', required: true }],
    handler: async (params: { name: string }) => ({ message: deleteCustomTool(params.name) ? `🗑️ Skill "${params.name}" gelöscht.` : `❌ Skill "${params.name}" nicht gefunden.` }),
}

export default { synthesizeSkill, skillSynthesisTool, listSkillsTool, deleteSkillTool }
