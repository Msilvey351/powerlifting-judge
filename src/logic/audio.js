// src/logic/audio.js
const MIN_INTERVAL_MS = 2000
const lastPlayed      = {}
let debugCallback     = null
let audioContext      = null
const audioBuffers    = {}

export function setAudioDebug(callback) {
  debugCallback = callback
}

function log(msg) {
  console.log(msg)
  if (debugCallback) debugCallback(msg)
}

export async function initAudio() {
  log('initAudio called')
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    log(`AudioContext state: ${audioContext.state}`)

    if (audioContext.state === 'suspended') {
      await audioContext.resume()
      log(`AudioContext resumed, state: ${audioContext.state}`)
    }

    // ── 'start' added for bench press ────────────────────────────────────────
    const files = ['squat', 'rack', 'down', 'start']

    await Promise.all(files.map(async (name) => {
      try {
        log(`fetching ${name}...`)
        const response = await fetch(`/audio/${name}.mp3`)
        if (!response.ok) {
          log(`${name} fetch HTTP error: ${response.status}`)
          return
        }
        const arrayBuffer = await response.arrayBuffer()
        log(`${name} arrayBuffer size: ${arrayBuffer.byteLength}`)
        audioBuffers[name] = await audioContext.decodeAudioData(arrayBuffer)
        log(`${name} decoded OK`)
      } catch (err) {
        log(`${name} FAILED: ${err.message}`)
      }
    }))

    log(`initAudio complete, buffers: ${Object.keys(audioBuffers).join(', ')}`)
  } catch (err) {
    log(`initAudio FAILED: ${err.message}`)
  }
}

export function speakCommand(command) {
  log(`speakCommand: ${command}`)

  const now  = Date.now()
  const last = lastPlayed[command] ?? 0
  if (now - last < MIN_INTERVAL_MS) {
    log('blocked by interval')
    return
  }
  lastPlayed[command] = now

  if (!audioContext) {
    log('ERROR: no AudioContext')
    return
  }

  log(`AudioContext state: ${audioContext.state}`)

  const buffer = audioBuffers[command.toLowerCase()]
  if (!buffer) {
    log(`ERROR: no buffer for: ${command}`)
    log(`available buffers: ${Object.keys(audioBuffers).join(', ')}`)
    return
  }

  try {
    const source    = audioContext.createBufferSource()
    source.buffer   = buffer
    source.connect(audioContext.destination)
    source.start(0)
    log(`playing OK: ${command}`)
  } catch (err) {
    log(`play FAILED: ${err.message}`)
  }
}