const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

// 2.86 Paket O „Anrufen“: die zwei offenen Live-Fixes aus dem Voice-Lab.
//  1. Knacken → ein durchgehender Player, Phrasen lückenlos, 15-ms-Rampen,
//     Abbruch blendet aus statt hart zu stoppen.
//  2. „Hört mich nicht“ → 16 kHz, 32-ms-Rahmen, Browser-Rauschunterdrückung aus.

function loadAnruf() {
  const context = { window: {}, document: {}, console, Promise, JSON, Math, Object, Uint8Array, atob: s => Buffer.from(s, 'base64').toString('binary') }
  vm.createContext(context)
  vm.runInContext(readFileSync(join(__dirname, '..', 'renderer', 'anruf.js'), 'utf8'), context)
  return context.window.XaventraAnruf
}

function fakeAudioContext() {
  const log = []
  const param = name => ({
    value: 1,
    setValueAtTime: (v, t) => log.push([name, 'set', v, t]),
    linearRampToValueAtTime: (v, t) => log.push([name, 'ramp', v, t]),
    cancelScheduledValues: t => log.push([name, 'cancel', t]),
  })
  let gains = 0
  const ctx = {
    currentTime: 10,
    destination: {},
    log,
    started: [],
    stopped: [],
    createGain() { const id = gains++; const node = { id, gain: param(`gain${id}`), connect: target => target, disconnect() {} }; return node },
    createBufferSource() {
      const node = { connect: target => target, start: t => ctx.started.push(t), stop: t => ctx.stopped.push(t), onended: null }
      return node
    },
    decodeAudioData: async bytes => ({ duration: bytes.byteLength / 1000 }),
  }
  return ctx
}

test('Aufnahme: 16 kHz mono, Rauschunterdrückung aus, Echo-Unterdrückung an', () => {
  const { CAPTURE } = loadAnruf()
  assert.equal(CAPTURE.audio.sampleRate, 16000)
  assert.equal(CAPTURE.audio.channelCount, 1)
  assert.equal(CAPTURE.audio.noiseSuppression, false)
  assert.equal(CAPTURE.audio.echoCancellation, true)
})

test('Player plant Phrasen lückenlos hintereinander, jede mit 15-ms-Rampe', async () => {
  const { createPlayer } = loadAnruf()
  const ctx = fakeAudioContext()
  const player = createPlayer(ctx)
  const first = await player.enqueue(new ArrayBuffer(500)) // 0,5 s
  const second = await player.enqueue(new ArrayBuffer(300)) // 0,3 s
  assert.equal(second.start, first.end, 'zweite Phrase beginnt genau am Ende der ersten (keine Lücke, kein Überlappen)')
  assert.deepEqual(ctx.started, [first.start, second.start])
  // Rampe der ersten Phrase: 0 → 1 in 15 ms, am Ende 1 → 0
  const ramps = ctx.log.filter(entry => entry[0] === 'gain1')
  assert.deepEqual(ramps[0], ['gain1', 'set', 0, first.start])
  assert.deepEqual(ramps[1], ['gain1', 'ramp', 1, first.start + 0.015])
  assert.deepEqual(ramps.at(-1), ['gain1', 'ramp', 0, first.end])
})

test('Abbrechen (Dazwischenreden) blendet in 15 ms aus und verwirft späte Phrasen', async () => {
  const { createPlayer } = loadAnruf()
  const ctx = fakeAudioContext()
  const player = createPlayer(ctx)
  await player.enqueue(new ArrayBuffer(500))
  const late = player.enqueue(new ArrayBuffer(500)) // dekodiert noch
  player.stop()
  assert.equal(await late, null, 'eine Phrase, die beim Abbruch noch dekodiert wurde, wird nicht mehr gespielt')
  assert.deepEqual(ctx.stopped, [ctx.currentTime + 0.015])
  const master = ctx.log.filter(entry => entry[0] === 'gain0')
  assert.ok(master.some(entry => entry[1] === 'ramp' && entry[2] === 0 && Math.abs(entry[3] - (ctx.currentTime + 0.015)) < 1e-9), 'Haupt-Regler blendet aus')
  assert.equal(player.playing, false)
})

function loadWorklet(rate) {
  const posted = []
  let Processor
  const context = {
    sampleRate: rate, Int16Array, Math,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: buffer => posted.push(new Int16Array(buffer)) } } },
    registerProcessor: (_name, cls) => { Processor = cls },
  }
  vm.createContext(context)
  vm.runInContext(readFileSync(join(__dirname, '..', 'renderer', 'anruf-worklet.js'), 'utf8'), context)
  return { processor: new Processor(), posted }
}

test('Worklet: 32-ms-Rahmen (512 Samples) bei 16 kHz', () => {
  const { processor, posted } = loadWorklet(16000)
  for (let i = 0; i < 8; i++) processor.process([[new Float32Array(128).fill(0.5)]])
  assert.equal(posted.length, 2)
  assert.equal(posted[0].length, 512)
  assert.ok(Math.abs(posted[0][0] - 16383) <= 1)
})

test('Worklet: läuft der Browser mit 48 kHz, wird auf 16 kHz gebracht', () => {
  const { processor, posted } = loadWorklet(48000)
  for (let i = 0; i < 12; i++) processor.process([[new Float32Array(128).fill(0.25)]]) // 1536 Samples à 48 kHz → 512 à 16 kHz
  assert.equal(posted.length, 1)
  assert.equal(posted[0].length, 512)
})
