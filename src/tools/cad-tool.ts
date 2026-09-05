/**
 * Nova CAD Generation Tool
 * 
 * Generates 3D models from text descriptions using build123d
 * and exports to STL for 3D printing.
 * 
 * Based on ADA V2's cad_agent.py approach
 */

import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const CAD_PROJECTS_DIR = join(process.cwd(), '.nova-data', 'cad', 'projects')

export const cadGenerateTool = {
    name: 'cad_generate',
    description: 'Generate a 3D CAD model from a text description. Creates parametric geometry using build123d and exports to STL format for 3D printing.',
    category: 'media' as const,
    parameters: [
        {
            name: 'description',
            type: 'string' as const,
            description: 'Text description of the 3D model to generate (e.g., "a cube with 10mm edges", "a cylinder with radius 5mm and height 20mm", "a hexagonal bolt with 8mm head")',
            required: true
        },
        {
            name: 'projectName',
            type: 'string' as const,
            description: 'Project name for organizing the output files',
            required: false,
            default: 'default'
        },
        {
            name: 'exportFormat',
            type: 'string' as const,
            description: 'Export format: stl (default), step, obj',
            required: false,
            default: 'stl'
        }
    ],
    handler: async (params: { description: string; projectName?: string; exportFormat?: string }) => {
        const { description, projectName = 'default', exportFormat = 'stl' } = params
        
        if (!existsSync(CAD_PROJECTS_DIR)) {
            mkdirSync(CAD_PROJECTS_DIR, { recursive: true })
        }
        
        const projectDir = join(CAD_PROJECTS_DIR, projectName)
        if (!existsSync(projectDir)) {
            mkdirSync(projectDir, { recursive: true })
        }
        
        const scriptPath = join(projectDir, `generate_${Date.now()}.py`)
        const pythonScript = generateBuild123dScript(description, exportFormat)
        writeFileSync(scriptPath, pythonScript, 'utf-8')
        
        return new Promise((resolve) => {
            const proc = spawn('python', [scriptPath], {
                cwd: projectDir,
                shell: true,
                timeout: 60000
            })
            
            let stdout = ''
            let stderr = ''
            
            proc.stdout?.on('data', (data) => { stdout += data.toString() })
            proc.stderr?.on('data', (data) => { stderr += data.toString() })
            
            proc.on('close', (code) => {
                if (code === 0) {
                    const files = getGeneratedFiles(projectDir)
                    resolve({
                        success: true,
                        output: files[0] || projectDir,
                        description,
                        projectName,
                        message: files.length > 0 ? `CAD generated: ${files[0].split('/').pop()}` : 'CAD generation completed'
                    })
                } else {
                    resolve({
                        success: false,
                        error: `CAD failed (code ${code}): ${stderr || stdout}`,
                        description
                    })
                }
            })
            
            proc.on('error', (err) => {
                resolve({
                    success: false,
                    error: `CAD error: ${err.message}`,
                    description
                })
            })
        })
    }
}

function generateBuild123dScript(description: string, exportFormat: string): string {
    const safeDesc = description.replace(/"/g, '\\"')
    const outputFile = exportFormat === 'step' ? 'output.step' : exportFormat === 'obj' ? 'output.obj' : 'output.stl'
    
    return `#!/usr/bin/env python3
"""
Nova CAD Generation - Generated from: "${safeDesc}"
"""

from build123d import *
import math
import os

def create_model():
    desc = """${safeDesc}""".lower()
    
    with BuildPart() as part:
        if "cube" in desc or "würfel" in desc or "box" in desc:
            size = 0.01
            m = re.search(r"(\\d+(?:\\.\\d+)?)\\s*(?:mm|cm|m)", desc)
            if m:
                v = float(m.group(1))
                size = v / 1000 if v < 100 else v / 100
            pos = (size/2, size/2, size/2) if "center" in desc else (0, 0, 0)
            Box(size, size, size, align=Align.CENTER if "center" in desc else Align.MIN)
            
        elif "cylinder" in desc or "zylinder" in desc:
            r, h = 0.005, 0.02
            rm = re.search(r"(?:radius|r)\\s*=?\\s*(\\d+(?:\\.\\d+)?)", desc)
            hm = re.search(r"(?:height|h|höhe)\\s*=?\\s*(\\d+(?:\\.\\d+)?)", desc)
            if rm: r = float(rm.group(1)) / 1000
            if hm: h = float(hm.group(1)) / 1000
            Cylinder(r, h)
            
        elif "sphere" in desc or "kugel" in desc:
            r = 0.01
            m = re.search(r"(\\d+(?:\\.\\d+)?)\\s*(?:mm|cm|m)", desc)
            if m:
                v = float(m.group(1))
                r = v / 1000 if v < 100 else v / 100
            Sphere(r)
            
        elif "cone" in desc or "kegel" in desc:
            r, h = 0.005, 0.015
            rm = re.search(r"(\\d+(?:\\.\\d+)?)\\s*(?:mm|cm|m)", desc)
            if rm:
                v = float(rm.group(1))
                r = v / 1000 if v < 100 else v / 100
            hm = re.search(r"(?:height|h|höhe)\\s*=?\\s*(\\d+(?:\\.\\d+)?)", desc)
            if hm: h = float(hm.group(1)) / 1000
            Cone(r, r * 0.5, h)
            
        elif "hex" in desc or "sechseck" in desc or "bolzen" in desc:
            s = 0.008
            m = re.search(r"(\\d+(?:\\.\\d+)?)\\s*(?:mm|cm|m)", desc)
            if m:
                v = float(m.group(1))
                s = v / 1000 if v < 100 else v / 100
            with BuildPart().build():
                with Locations((0, 0, 0)):
                    hexagon = RegularPolygon(radius=s, num_sides=6)
                    extrude(amount=s * 0.6)
                    
        elif "bolt" in desc or "schraube" in desc:
            s = 0.006
            m = re.search(r"(\\d+(?:\\.\\d+)?)\\s*(?:mm|cm|m)", desc)
            if m:
                v = float(m.group(1))
                s = v / 1000 if v < 100 else v / 100
            with BuildPart().build():
                Cylinder(s * 1.5, s * 0.5)
                Cylinder(s * 0.6, s * 3, position=(0, 0, -s * 0.5))
                
        elif "ring" in desc or "torus" in desc:
            r, tube = 0.01, 0.002
            rm = re.search(r"(\\d+(?:\\.\\d+)?)\\s*(?:mm|cm|m)", desc)
            if rm:
                v = float(rm.group(1))
                r = v / 1000 if v < 100 else v / 100
            Torus(r, tube)
            
        else:
            Box(0.02, 0.02, 0.02)
    
    return part

try:
    import re
    part = create_model()
    export_path = "${outputFile}"
    exporters.export(part, export_path)
    print(f"SUCCESS:{export_path}")
except Exception as e:
    print(f"ERROR:{e}")
    import traceback
    traceback.print_exc()
`
}

function getGeneratedFiles(dir: string): string[] {
    const { readdirSync } = require('node:fs')
    try {
        return readdirSync(dir)
            .filter(f => f.endsWith('.stl') || f.endsWith('.step') || f.endsWith('.obj'))
            .map(f => join(dir, f))
    } catch {
        return []
    }
}

export default { cadGenerateTool }