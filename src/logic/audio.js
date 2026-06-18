const MIN_INTERVAL_MS = 2000

const lastPlayed = {}
let debugCallback = null
let audioContext = null
const audioBuffers = {}
let initPromise = null

export function setAudioDebug(callback) {
  debugCallback = callback
}

function log(msg) {
  console.log(msg)
  if (debugCallback) debugCallback(msg)
}

async function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    log(`AudioContext created, state: ${audioContext.state}`)
  }

  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume()
      log(`AudioContext resumed, state: ${audioContext.state}`)
    } catch (err) {
      log(`AudioContext resume failed: ${err.message}`)
    }
  }

  return audioContext
}

export async function initAudio() {
  // Prevent multiple parallel initialisations
  if (initPromise) return initPromise

  initPromise = (async () => {
    log('initAudio called')

    try {
      await ensureAudioContext()

      const files = ['squat', 'rack', 'down', 'start', 'press']

      await Promise.all(files.map(async (name) => {
        // Already loaded
        if (audioBuffers[name]) return

        try {
          log(`fetching ${name}...`)
          const response = await fetch(`/audio/${name}.mp3`, {
            cache: 'reload',
          })

          if (!response.ok) {
            log(`${name} fetch HTTP error: ${response.status}`)
            return
          }

          const arrayBuffer = await response.arrayBuffer()
          log(`${name} arrayBuffer size: ${arrayBuffer.byteLength}`)

          if (arrayBuffer.byteLength < 500) {
            log(`${name} WARNING: file looks too small to be valid audio`)
          }

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
  })()

  return initPromise
}

export async function speakCommand(command) {
  const key = command.toLowerCase()
  log(`speakCommand: ${key}`)

  const now  = Date.now()
  const last = lastPlayed[key] ?? 0

  if (now - last < MIN_INTERVAL_MS) {
    log(`blocked by interval: ${key}`)
    return
  }

  lastPlayed[key] = now

  await initAudio()
  await ensureAudioContext()

  const buffer = audioBuffers[key]

  if (!buffer) {
    log(`ERROR: no buffer for: ${key}`)
    log(`available buffers: ${Object.keys(audioBuffers).join(', ')}`)
    return
  }

  try {
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(audioContext.destination)
    source.start(0)
    log(`playing OK: ${key}`)
  } catch (err) {
    log(`play FAILED: ${err.message}`)
  }
}