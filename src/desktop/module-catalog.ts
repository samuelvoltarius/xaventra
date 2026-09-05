import { ALL_TOOLS } from '../tools/complete-registry.js'

export interface DesktopModule {
    id: string
    name: string
    category: 'voice' | 'vision' | 'design' | 'automation' | 'productivity'
    description: string
    status: 'ready' | 'partial' | 'setup-required'
    toolNames: string[]
    availableTools: string[]
    missingTools: string[]
    inspiration?: string
    limitation?: string
}

const MODULES: Array<Omit<DesktopModule, 'status' | 'availableTools' | 'missingTools'>> = [
    {
        id: 'local-voice', name: 'Local Voice', category: 'voice',
        description: 'Wake Word, lokale Transkription und Sprachausgabe mit automatischem Provider-Fallback.',
        toolNames: ['transcribe_audio', 'speak', 'voice_setup'], inspiration: 'ADA Local',
        limitation: 'Echtes Full-Duplex/Barge-in ist noch kein durchgängiger Desktop-Stream.',
    },
    {
        id: 'visual-awareness', name: 'Visual Awareness', category: 'vision',
        description: 'Screen/Webcam-Aufnahme, Face Detection, Handgesten und Vision-Analyse.',
        toolNames: ['screen_capture', 'webcam_capture', 'face_detect', 'hand_gesture', 'screen_analyze'], inspiration: 'ADA v2',
        limitation: 'Face Detection ist keine Login- oder Identitätsfreigabe. Biometrie bleibt opt-in und node-lokal.',
    },
    {
        id: 'cad-studio', name: 'CAD Studio', category: 'design',
        description: 'Parametrische Modelle aus Sprache/Text, Projektartefakte und STL/STEP/OBJ-Ausgabe.',
        toolNames: ['cad_generate'], inspiration: 'ADA v2',
        limitation: 'Generierte Modelle müssen vor dem Druck visuell und geometrisch validiert werden.',
    },
    {
        id: 'print-lab', name: '3D Print Lab', category: 'design',
        description: 'Druckerstatus, Slicing und kontrollierte Jobs für Moonraker/Klipper, OctoPrint und PrusaLink.',
        toolNames: ['printer_status', 'printer_files', 'printer_start', 'printer_pause', 'printer_resume', 'printer_cancel'], inspiration: 'ADA v2',
        limitation: 'Start, G-Code und externe Druckaktionen bleiben Tool-Gate- und Evidence-pflichtig.',
    },
    {
        id: 'smart-home', name: 'Smart Home', category: 'automation',
        description: 'Home-Assistant-Entitäten, Services, Szenen und Geräte über eine zentrale Integration.',
        toolNames: ['hass_status', 'hass_list', 'hass_get', 'hass_turn_on', 'hass_turn_off', 'hass_toggle', 'hass_service'], inspiration: 'ADA Local',
        limitation: 'Direkte herstellerspezifische Steuerung wird bevorzugt über Home Assistant vereinheitlicht.',
    },
    {
        id: 'browser-workspace', name: 'Browser Workspace', category: 'automation',
        description: 'Playwright-basierte Recherche und Browser-Automation mit sichtbaren Tool-Ergebnissen.',
        toolNames: ['browser_open', 'browser_navigate', 'browser_click', 'browser_type', 'browser_extract', 'browser_screenshot'], inspiration: 'ADA v2',
        limitation: 'Externe Aktionen und Logins bleiben freigabe- und sessiongebunden.',
    },
    {
        id: 'project-workspace', name: 'Project Workspace', category: 'productivity',
        description: 'Themenräume, Projekte, Checkpoints, Artefakte und Governed Memory in einem Arbeitskontext.',
        toolNames: ['project_create', 'project_list', 'project_status'], inspiration: 'ADA v2',
        limitation: 'Projekt-Memory wird nicht als globales Benutzer-Memory behandelt.',
    },
    {
        id: 'skill-forge', name: 'Skill Forge', category: 'productivity',
        description: 'Sichtbare Skill-Entwürfe mit Code-Hash, Abhängigkeiten, Reifestufen und überprüfbarer Evidence.',
        toolNames: ['build_skill', 'create_skill', 'list_skills'], inspiration: 'Ada-SI',
        limitation: 'Kein beliebiges Python und kein automatisches pip: Aktivierung erst nach nativer Sandbox, Benchmark, Canary und Owner-Freigabe.',
    },
]

export function getDesktopModuleCatalog(): DesktopModule[] {
    const registered = new Set(ALL_TOOLS.map(tool => tool.name))
    return MODULES.map(module => {
        const availableTools = module.toolNames.filter(name => registered.has(name))
        const missingTools = module.toolNames.filter(name => !registered.has(name))
        return {
            ...module,
            availableTools,
            missingTools,
            status: missingTools.length === 0 ? 'ready' : availableTools.length > 0 ? 'partial' : 'setup-required',
        }
    })
}
