// src/screens/CameraScreen.jsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision'
import { initAudio, speakCommand }   from '../logic/audio'
import { extractLandmarks }          from '../logic/poseUtils'
import { BarDetector }               from '../logic/barDetector'
import { getBenchCalibration }       from '../logic/calibrationStore'
import {
  SquatReferee,
  DeadliftReferee,
  BenchReferee,
  LiftResult,
  STATE_MESSAGES,
  DEADLIFT_STATE_MESSAGES,
  BENCH_STATE_MESSAGES,
} from '../logic/stateMachine'
import StatusBar      from '../widgets/StatusBar'
import ResultsOverlay from '../widgets/ResultsOverlay'

// ── Utility — race a promise against a timeout ────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ])
}

function CameraScreen() {
  const navigate                 = useNavigate()
  const { liftId, angle, reps }  = useParams()
  const [searchParams]           = useSearchParams()
  const lifterName               = searchParams.get('lifter') ?? null

  const videoRef            = useRef(null)
  const canvasRef           = useRef(null)
  const poseLandmarkerRef   = useRef(null)
  const animationFrameRef   = useRef(null)
  const refereeRef          = useRef(null)
  const barDetectorRef      = useRef(null)
  const repResultsRef       = useRef([])

  const [status,      setStatus]      = useState('Loading pose detection...')
  const [cameraError, setCameraError] = useState(null)
  const [result,      setResult]      = useState(LiftResult.PENDING)
  const [repResults,  setRepResults]  = useState([])

  const totalReps     = parseInt(reps, 10)
  const isBench       = liftId === 'bench'
  const isDeadlift    = liftId === 'deadlift'
  const stateMessages = isBench    ? BENCH_STATE_MESSAGES
                      : isDeadlift ? DEADLIFT_STATE_MESSAGES
                      : STATE_MESSAGES

  const formatParam = (str) => str.charAt(0).toUpperCase() + str.slice(1)

  const handleCommand = useCallback((command) => {
    speakCommand(command)
  }, [])

  // ── Detection loop ──────────────────────────────────────────────────────────
  const startDetectionLoop = useCallback(() => {
    const video          = videoRef.current
    const canvas         = canvasRef.current
    const poseLandmarker = poseLandmarkerRef.current
    const referee        = refereeRef.current
    if (!video || !canvas || !poseLandmarker || !referee) {
      console.warn('[CameraScreen] startDetectionLoop called but refs not ready')
      return
    }

    console.log('[CameraScreen] Detection loop starting')
    const ctx          = canvas.getContext('2d')
    const drawingUtils = new DrawingUtils(ctx)

    const detect = () => {
      canvas.width  = video.videoWidth
      canvas.height = video.videoHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (video.readyState >= 2) {
        try {
          const results = poseLandmarker.detectForVideo(video, performance.now())

          if (results.landmarks?.length > 0) {
            const rawLandmarks = results.landmarks[0]

            drawingUtils.drawConnectors(
              rawLandmarks,
              PoseLandmarker.POSE_CONNECTIONS,
              { color: '#00FF00', lineWidth: 2 }
            )
            drawingUtils.drawLandmarks(
              rawLandmarks,
              { color: '#FF0000', lineWidth: 1, radius: 3 }
            )

            const landmarks = extractLandmarks(rawLandmarks)

            let barY = null
            if (isBench && barDetectorRef.current) {
              const wristY = landmarks.left_wrist?.y ?? landmarks.right_wrist?.y ?? null
              barY = barDetectorRef.current.processFrame(video, wristY)
            }

            const update = isBench
              ? referee.update(landmarks, barY)
              : referee.update(landmarks)

            if (update.currentRep > 0) {
              setStatus(`Rep ${update.currentRep}/${totalReps} — ${stateMessages[update.state] ?? update.state}`)
            } else {
              setStatus(stateMessages[update.state] ?? update.state)
            }

            if (update.result !== LiftResult.PENDING) {
              setResult(prev => {
                if (prev === LiftResult.PENDING) {
                  repResultsRef.current = update.repResults
                  setRepResults(update.repResults)
                }
                return update.result
              })
            } else {
              setResult(LiftResult.PENDING)
            }

          } else {
            setStatus('READY — Get into position')
          }
        } catch (err) {
          console.error('[CameraScreen] Detection error:', err)
        }
      }

      animationFrameRef.current = requestAnimationFrame(detect)
    }

    detect()
  }, [totalReps, stateMessages, isBench])

  // ── Start camera ────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    console.log('[CameraScreen] Starting camera...')
    const attempts = [
      { video: { facingMode: 'user' } },
      { video: { facingMode: 'environment' } },
      { video: true },
    ]

    let stream    = null
    let lastError = null

    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        break
      } catch (err) {
        lastError = err
      }
    }

    if (!stream) {
      setCameraError(lastError.name + ': ' + lastError.message)
      return
    }

    const video = videoRef.current
    if (!video) return

    video.srcObject = stream

    await new Promise((resolve) => {
      if (video.readyState >= 2) { resolve(); return }
      video.onloadeddata = () => resolve()
      setTimeout(resolve, 3000)
    })

    try {
      await video.play()
    } catch (err) {
      console.warn('[CameraScreen] video.play() warning:', err)
    }

    console.log('[CameraScreen] Camera ready, starting detection loop')
    setStatus('READY — Get into position')
    startDetectionLoop()

  }, [startDetectionLoop])

  // ── Load everything ─────────────────────────────────────────────────────────
  useEffect(() => {
    const setup = async () => {
      console.log('[CameraScreen] Setup starting...')
      await initAudio()

      if (isBench) {
        const calibration      = lifterName ? getBenchCalibration(lifterName) : null
        refereeRef.current     = new BenchReferee(handleCommand, totalReps, angle, calibration)
        barDetectorRef.current = new BarDetector()
      } else if (isDeadlift) {
        refereeRef.current = new DeadliftReferee(handleCommand, totalReps, angle)
      } else {
        refereeRef.current = new SquatReferee(handleCommand, totalReps)
      }

      const modelPath = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

      try {
        console.log('[CameraScreen] Loading MediaPipe vision...')
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        )
        console.log('[CameraScreen] FilesetResolver ready, creating PoseLandmarker...')

        try {
          // Race GPU init against 8 second timeout
          poseLandmarkerRef.current = await withTimeout(
            PoseLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: modelPath, delegate: 'GPU' },
              runningMode: 'VIDEO',
              numPoses:    1,
            }),
            8000,
            'GPU delegate'
          )
          console.log('[CameraScreen] PoseLandmarker ready (GPU)')
        } catch (gpuErr) {
          console.warn('[CameraScreen] GPU failed or timed out, falling back to CPU:', gpuErr.message)
          poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
            runningMode: 'VIDEO',
            numPoses:    1,
          })
          console.log('[CameraScreen] PoseLandmarker ready (CPU fallback)')
        }

        await startCamera()

      } catch (err) {
        console.error('[CameraScreen] Setup failed:', err)
        setCameraError('Failed to load: ' + err.message)
      }
    }

    setup()

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
      if (poseLandmarkerRef.current)  poseLandmarkerRef.current.close()
      if (barDetectorRef.current)     barDetectorRef.current.dispose()
    }
  }, [handleCommand, startCamera, totalReps, isBench, isDeadlift, angle, lifterName])

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleBack    = () => navigate('/')
  const handleDismiss = () => {
    setResult(LiftResult.PENDING)
    setRepResults([])
    repResultsRef.current = []
    refereeRef.current?.reset()
    navigate('/')
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <button onClick={handleBack} style={styles.backButton}>← Back</button>
        <span style={styles.liftInfo}>
          {formatParam(liftId)} | {formatParam(angle)} | {totalReps} {totalReps === 1 ? 'rep' : 'reps'}
          {lifterName ? ` | ${lifterName}` : ''}
        </span>
      </div>

      <div style={styles.cameraArea}>
        {cameraError ? (
          <p style={styles.errorText}>Error: {cameraError}</p>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
            <canvas ref={canvasRef} style={styles.canvas} />
            {result !== LiftResult.PENDING && (
              <ResultsOverlay
                repResults={repResults}
                totalReps={totalReps}
                onDismiss={handleDismiss}
              />
            )}
          </>
        )}
      </div>

      <StatusBar status={status} />
    </div>
  )
}

const styles = {
  container:  { display: 'flex', flexDirection: 'column', height: '100vh', background: '#000' },
  topBar:     { display: 'flex', alignItems: 'center', padding: '12px 16px', background: '#111', gap: '16px', flexShrink: 0 },
  backButton: { fontSize: '16px', color: '#888' },
  liftInfo:   { fontSize: '14px', fontWeight: '500', color: '#fff' },
  cameraArea: { flex: 1, position: 'relative', background: '#000', overflow: 'hidden' },
  video:      { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' },
  canvas:     { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  errorText:  { color: 'red', fontSize: '14px', padding: '16px', textAlign: 'center' },
}

export default CameraScreen