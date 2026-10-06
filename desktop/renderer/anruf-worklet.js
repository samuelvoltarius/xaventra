// Mikrofon → PCM16 mono 16 kHz in 32-ms-Rahmen (512 Samples) für den Sprachdienst.
// (2.86 Paket O; Voice-Lab-Fix „hört mich die halbe Zeit nicht“: echter 16-kHz-Pfad,
// feste 32-ms-Rahmen.) Läuft der AudioContext doch mit 44,1/48 kHz, wird hier linear
// auf 16 kHz gebracht.
class XaventraPcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.frame = new Int16Array(512)
    this.offset = 0
    this.position = 0 // Lesestelle im Eingang (in Eingangs-Samples), über Blöcke hinweg
    this.last = 0
  }

  push(value) {
    const v = Math.max(-1, Math.min(1, value))
    this.frame[this.offset++] = v < 0 ? v * 32768 : v * 32767
    if (this.offset === this.frame.length) {
      this.port.postMessage(this.frame.buffer, [this.frame.buffer])
      this.frame = new Int16Array(512)
      this.offset = 0
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    if (this.ratio === 1) {
      for (let i = 0; i < input.length; i++) this.push(input[i])
      return true
    }
    // Lineare Interpolation zwischen letztem Sample des Vorblocks und diesem Block.
    while (this.position < input.length) {
      const left = Math.floor(this.position)
      const frac = this.position - left
      const a = left === 0 ? this.last : input[left - 1]
      const b = input[left]
      this.push(a + (b - a) * frac)
      this.position += this.ratio
    }
    this.position -= input.length
    this.last = input[input.length - 1]
    return true
  }
}
registerProcessor('xaventra-pcm16', XaventraPcm16Capture)
