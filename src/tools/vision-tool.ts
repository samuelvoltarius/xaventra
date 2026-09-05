/**
 * Nova Visual Awareness Tool
 * 
 * Based on MARK XXXIX's screen processing and ADA V2's MediaPipe vision:
 * - Capture screen and webcam
 * - Process images for context
 * - Detect faces and gestures
 */

import { spawn } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const VISION_DIR = join(process.cwd(), '.nova-data', 'vision')

export const screenCaptureTool = {
    name: 'screen_capture',
    description: 'Capture the current screen or a specific region. Returns base64-encoded image for vision analysis.',
    category: 'media' as const,
    parameters: [
        {
            name: 'region',
            type: 'string',
            description: 'Capture region: "full" (default), "window", or "region" with x,y,width,height',
            required: false,
            default: 'full'
        },
        {
            name: 'outputPath',
            type: 'string',
            description: 'Optional path to save the screenshot',
            required: false
        }
    ],
    handler: async (params: { region?: string; outputPath?: string }) => {
        const { region = 'full', outputPath } = params
        
        if (!existsSync(VISION_DIR)) {
            mkdirSync(VISION_DIR, { recursive: true })
        }
        
        const screenshotPath = outputPath || join(VISION_DIR, `screenshot_${Date.now()}.png`)
        
        // ── Linux: der Bildschirm gehoert dem X-Server, nicht PowerShell ──
        // Hier stand nur ein Windows-Zweig, der `powershell` aufrief. Auf
        // NovaOS ergab das `/bin/sh: 1: Syntax error: "(" unexpected` — Nova
        // war blind und schloss daraus sogar, es gebe "keinen Desktop",
        // waehrend die Oberflaeche sichtbar lief. Am 30.08.2026 gemessen.
        //
        // Zwei Stolpersteine auf dem Weg:
        //   1. Nova laeuft als root, der Bildschirm gehoert dem Benutzer nova.
        //      Ohne die passende Xauthority kommt nur "Authorization required".
        //      Wo die Datei liegt, entscheidet der Anmeldedienst — deshalb
        //      werden mehrere uebliche Orte durchprobiert.
        //   2. scrot ist da, `import`/`xwd` nicht zwingend — also der Reihe nach.
        if (process.platform !== 'win32') {
            const { execFileSync } = await import('node:child_process')
            const { globSync } = await import('node:fs')

            const anzeige = process.env.DISPLAY || ':0'
            const authKandidaten = [
                process.env.XAUTHORITY,
                '/home/nova/.Xauthority',
                ...(() => {
                    try { return globSync('/var/run/lightdm/*/xauthority') } catch { return [] }
                })(),
                '/run/user/1000/gdm/Xauthority',
            ].filter((x): x is string => typeof x === 'string' && x.length > 0 && existsSync(x))

            const versuche: Array<[string, string[]]> = [
                ['scrot', ['-o', '-z', screenshotPath]],
                ['import', ['-window', 'root', screenshotPath]],
                ['xwd', ['-root', '-silent', '-out', screenshotPath]],
            ]

            for (const auth of [...authKandidaten, '']) {
                for (const [befehl, argumente] of versuche) {
                    try {
                        execFileSync(befehl, argumente, {
                            timeout: 15000,
                            env: {
                                ...process.env,
                                DISPLAY: anzeige,
                                ...(auth ? { XAUTHORITY: auth } : {}),
                            },
                            stdio: 'ignore',
                        })
                        if (existsSync(screenshotPath)) {
                            const buffer = readFileSync(screenshotPath)
                            return {
                                success: true,
                                path: screenshotPath,
                                screenshotPath,
                                base64: buffer.toString('base64'),
                                mimeType: 'image/png',
                                imagePath: screenshotPath,
                                message: `Bildschirmfoto aufgenommen (${befehl}).`,
                            }
                        }
                    } catch { /* naechster Versuch */ }
                }
            }

            return {
                success: false,
                error: 'Bildschirmfoto nicht moeglich',
                // Klartext statt Ratespiel: das hier ist genau das, was fehlt.
                message: `Kein Bildschirmfoto moeglich. Geprueft: DISPLAY=${anzeige}, `
                    + `Xauthority-Kandidaten: ${authKandidaten.length ? authKandidaten.join(', ') : 'keine gefunden'}, `
                    + `Werkzeuge: scrot/import/xwd. Das heisst NICHT, dass kein Desktop laeuft — `
                    + `nur, dass ich ihn gerade nicht fotografieren kann.`,
            }
        }

        return new Promise((resolve) => {
            // Windows: use PowerShell to capture screen
            const psScript = region === 'full'
                ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${screenshotPath.replace(/\\/g, '\\\\')}'); $bmp.Dispose(); $g.Dispose() }; Write-Output 'OK'`
                : `Write-Output 'Region capture not implemented'`
            
            const proc = spawn('powershell', ['-NoProfile', '-Command', psScript], {
                timeout: 15000,
                shell: true
            })
            
            let stderr = ''
            proc.stderr?.on('data', (d) => { stderr += d.toString() })
            
            proc.on('close', (code) => {
                if (code === 0 && existsSync(screenshotPath)) {
                    // Read and encode
                    // war: require('node:fs') - in ESM ein ReferenceError
                    // mitten im Event-Handler, also potenziell fataler Absturz.
                    const buffer = readFileSync(screenshotPath)
                    const base64 = buffer.toString('base64')
                    
                    resolve({
                        success: true,
                        path: screenshotPath,
                        screenshotPath,
                        base64,
                        // nova-runner forwards these to the vision pipeline so the
                        // model SEES the screenshot instead of hallucinating it.
                        imageBase64: base64,
                        imageMimeType: 'image/png',
                        size: buffer.length,
                        message: `Screenshot captured: ${screenshotPath}`
                    })
                } else {
                    resolve({
                        success: false,
                        error: `Screen capture failed: ${stderr}`,
                        code
                    })
                }
            })
            
            proc.on('error', (err) => {
                resolve({
                    success: false,
                    error: err.message
                })
            })
        })
    }
}

export const webcamCaptureTool = {
    name: 'webcam_capture',
    description: 'Capture image from webcam. Requires webcam to be available.',
    category: 'media' as const,
    parameters: [
        {
            name: 'cameraIndex',
            type: 'number',
            description: 'Camera index (0 = default webcam)',
            required: false,
            default: 0
        },
        {
            name: 'outputPath',
            type: 'string',
            description: 'Optional path to save the image',
            required: false
        }
    ],
    handler: async (params: { cameraIndex?: number; outputPath?: string }) => {
        const { cameraIndex = 0, outputPath } = params
        
        if (!existsSync(VISION_DIR)) {
            mkdirSync(VISION_DIR, { recursive: true })
        }
        
        const imagePath = outputPath || join(VISION_DIR, `webcam_${Date.now()}.jpg`)
        
        return new Promise((resolve) => {
            // Use OpenCV or simple Windows camera capture
            const captureScript = `
import cv2
import sys

try:
    cap = cv2.VideoCapture(${cameraIndex})
    if not cap.isOpened():
        print('ERROR:Could not open camera')
        sys.exit(1)
    
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        print('ERROR:Failed to capture frame')
        sys.exit(1)
    
    cv2.imwrite('${imagePath.replace(/\\/g, '\\\\')}', frame)
    print('OK:${imagePath}')
except Exception as e:
    print(f'ERROR:{e}')
    sys.exit(1)
`
            const scriptPath = join(VISION_DIR, 'capture.py')
            writeFileSync(scriptPath, captureScript, 'utf-8')
            
            const proc = spawn('python', [scriptPath], {
                timeout: 15000,
                shell: true
            })
            
            let stdout = ''
            proc.stdout?.on('data', (d) => { stdout += d.toString() })
            
            proc.on('close', (code) => {
                if (code === 0 && existsSync(imagePath)) {
                    const { readFileSync } = require('node:fs')
                    const buffer = readFileSync(imagePath)
                    const base64 = buffer.toString('base64')
                    
                    resolve({
                        success: true,
                        path: imagePath,
                        base64,
                        size: buffer.length,
                        message: `Webcam capture saved: ${imagePath}`
                    })
                } else {
                    resolve({
                        success: false,
                        error: stdout.includes('ERROR') ? stdout : 'Webcam capture failed',
                        code
                    })
                }
            })
            
            proc.on('error', (err) => {
                resolve({
                    success: false,
                    error: err.message
                })
            })
        })
    }
}

export const faceDetectionTool = {
    name: 'face_detect',
    description: 'Detect faces in an image using MediaPipe. Returns face locations and landmarks.',
    category: 'media' as const,
    parameters: [
        {
            name: 'imagePath',
            type: 'string',
            description: 'Path to image file or base64 encoded image',
            required: true
        },
        {
            name: 'minConfidence',
            type: 'number',
            description: 'Minimum confidence score (0-1)',
            required: false,
            default: 0.5
        }
    ],
    handler: async (params: { imagePath: string; minConfidence?: number }) => {
        const { imagePath: imgPath, minConfidence = 0.5 } = params
        
        return new Promise((resolve) => {
            // MediaPipe face detection Python script
            const detectScript = `
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import base64
import sys

try:
    # Handle base64 or file path
    if "${imgPath}".startswith('data:'):
        # base64 data URL
        pass  # Would need actual image data handling
    else:
        image = mp.Image.create_from_file("${imgPath}")
    
    # Face detection
    base_options = python.BaseOptions(model_asset_path='blaze_face_short_range.tflite')
    options = vision.FaceDetectorOptions(base_options=base_options)
    detector = vision.FaceDetector.create_from_options(options)
    
    result = detector.detect(image)
    
    faces = []
    for detection in result.detections:
        bbox = detection.bounding_box
        score = detection.categories[0].score
        if score >= ${minConfidence}:
            faces.append({
                'score': float(score),
                'x': bbox.origin_x,
                'y': bbox.origin_y,
                'width': bbox.width,
                'height': bbox.height
            })
    
    print(f"FACES:{len(faces)}")
    for f in faces:
        print(f"{f['x']},{f['y']},{f['width']},{f['height']},{f['score']}")
        
except Exception as e:
    print(f"ERROR:{e}")
    sys.exit(1)
`
            const scriptPath = join(VISION_DIR, 'face_detect.py')
            writeFileSync(scriptPath, detectScript, 'utf-8')
            
            const proc = spawn('python', [scriptPath], {
                timeout: 30000,
                shell: true
            })
            
            let stdout = ''
            proc.stdout?.on('data', (d) => { stdout += d.toString() })
            
            proc.on('close', (code) => {
                if (code === 0 && stdout.includes('FACES:')) {
                    const lines = stdout.trim().split('\n')
                    const countLine = lines[0]
                    const faces = []
                    
                    for (const line of lines.slice(1)) {
                        if (line && line.includes(',')) {
                            const [x, y, w, h, score] = line.split(',')
                            faces.push({
                                x: parseInt(x),
                                y: parseInt(y),
                                width: parseInt(w),
                                height: parseInt(h),
                                confidence: parseFloat(score)
                            })
                        }
                    }
                    
                    resolve({
                        success: true,
                        faceCount: faces.length,
                        faces,
                        message: `Detected ${faces.length} face(s)`
                    })
                } else {
                    resolve({
                        success: false,
                        error: stdout.includes('ERROR') ? stdout : 'Face detection failed',
                        faceCount: 0,
                        faces: []
                    })
                }
            })
            
            proc.on('error', (err) => {
                resolve({
                    success: false,
                    error: err.message,
                    faceCount: 0,
                    faces: []
                })
            })
        })
    }
}

export const handGestureTool = {
    name: 'hand_gesture',
    description: 'Detect hand gestures using MediaPipe Hands. Returns gesture type and hand positions.',
    category: 'media' as const,
    parameters: [
        {
            name: 'imagePath',
            type: 'string',
            description: 'Path to image file',
            required: true
        },
        {
            name: 'mode',
            type: 'string',
            description: 'Detection mode: "gesture" (classify gesture) or "landmarks" (get hand points)',
            required: false,
            default: 'gesture'
        }
    ],
    handler: async (params: { imagePath: string; mode?: string }) => {
        const { imagePath: imgPath, mode = 'gesture' } = params
        
        return new Promise((resolve) => {
            const gestureScript = `
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import sys

try:
    image = mp.Image.create_from_file("${imgPath}")
    
    # Hands detection
    base_options = python.BaseOptions(model_asset_path='hand_landmarker.task')
    options = vision.HandLandmarkerOptions(base_options=base_options, num_hands=2)
    detector = vision.HandLandmarker.create_from_options(options)
    
    result = detector.detect(image)
    
    hands = []
    gestures = []
    
    for hand in result.hand_landmarks:
        # Get landmark positions
        landmarks = [{'x': p.x, 'y': p.y, 'z': p.z} for p in hand]
        
        # Calculate gesture from landmarks
        # Pinch: thumb tip and index tip distance
        thumb_tip = landmarks[4]
        index_tip = landmarks[8]
        pinch_dist = ((thumb_tip['x'] - index_tip['x'])**2 + (thumb_tip['y'] - index_tip['y'])**2)**0.5
        
        if pinch_dist < 0.05:
            gestures.append('pinch')
        elif landmarks[4]['x'] < landmarks[3]['x']:  # Thumb extended
            gestures.append('open_palm')
        else:
            gestures.append('fist')
        
        hands.append({'landmarks': landmarks, 'gesture': gestures[-1]})
    
    print(f"HANDS:{len(hands)}")
    for h, g in zip(hands, gestures):
        print(f"GESTURE:{g}")
        
except Exception as e:
    print(f"ERROR:{e}")
    sys.exit(1)
`
            const scriptPath = join(VISION_DIR, 'hand_gesture.py')
            writeFileSync(scriptPath, gestureScript, 'utf-8')
            
            const proc = spawn('python', [scriptPath], {
                timeout: 30000,
                shell: true
            })
            
            let stdout = ''
            proc.stdout?.on('data', (d) => { stdout += d.toString() })
            
            proc.on('close', (code) => {
                if (code === 0 && stdout.includes('HANDS:')) {
                    const lines = stdout.trim().split('\n')
                    const handCount = parseInt(lines[0].split(':')[1])
                    const detectedGestures = lines.filter(l => l.startsWith('GESTURE:')).map(l => l.split(':')[1])
                    
                    resolve({
                        success: true,
                        handCount,
                        gestures: detectedGestures,
                        message: `Detected: ${detectedGestures.join(', ')}`
                    })
                } else {
                    resolve({
                        success: false,
                        error: stdout.includes('ERROR') ? stdout : 'Hand gesture detection failed',
                        handCount: 0,
                        gestures: []
                    })
                }
            })
            
            proc.on('error', (err) => {
                resolve({
                    success: false,
                    error: err.message,
                    handCount: 0,
                    gestures: []
                })
            })
        })
    }
}

export const screenAnalysisTool = {
    name: 'screen_analyze',
    description: 'Analyze screen content using vision model to describe what is displayed.',
    category: 'media' as const,
    parameters: [
        {
            name: 'imagePath',
            type: 'string',
            description: 'Path to screenshot or base64 encoded image',
            required: true
        },
        {
            name: 'question',
            type: 'string',
            description: 'Question about the screen content',
            required: false,
            default: 'What is shown on the screen?'
        }
    ],
    handler: async (params: { imagePath: string; question?: string }) => {
        const { imagePath: imgPath, question = 'What is shown on the screen?' } = params
        
        // Read image and encode as base64
        if (!existsSync(imgPath)) {
            return { success: false, error: `Image not found: ${imgPath}` }
        }
        
        const { readFileSync } = require('node:fs')
        const buffer = readFileSync(imgPath)
        const base64 = buffer.toString('base64')
        
        // Use MiniMax vision API to analyze
        return {
            success: true,
            base64,
            message: 'Screen captured - use vision model to analyze',
            note: 'Vision analysis requires MiniMax-M3 or vision-capable model'
        }
    }
}

export default {
    screenCaptureTool,
    webcamCaptureTool,
    faceDetectionTool,
    handGestureTool,
    screenAnalysisTool
}