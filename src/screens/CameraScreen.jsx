import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision'
import { initAudio, speakCommand } from '../logic/audio'
import { extractLandmarks } from '../logic/poseUtils'
import {
  SquatReferee,
  DeadliftReferee,
  LiftResult,
  STATE_MESSAGES,
  DEADLIFT_STATE_MESSAGES
} from '../logic/stateMachine'
import StatusBar from '../widgets/StatusBar'
import ResultsOverlay from '../widgets/ResultsOverlay'

function CameraScreen() {
  const navigate               = useNavigate()
  const { liftId, angle, reps } = useParams()
  const videoRef               = useRef(null)
  const canvasRef              = useRef(null)
  const poseLandmarkerRef      = useRef(null)
  const animationFrameRef      = useRef(null)
  const refereeRef             = useRef(null)
  const checksRef              = useRef([])
  const repResultsRef          = useRef([])

  const [status,     setStatus]     = useState('Loading pose detection...')
  const [cameraError, setCameraError] = useState(null)
  const [result,     setResult]     = useState(LiftResult.PENDING)
  const [repResults, setRepResults] = useState([])

  const totalReps     = parseInt(reps, 10)
  const isDeadlift    = liftId === 'deadlift'
  const stateMessages = isDeadlift ? DEADLIFT_STATE_MESSAGES : STATE_MESSAGES

  const formatParam = (str) => str.charAt(0).toUpperCase() + str.slice(1)

  // command callback - called by the state machine when a command is due
  const handleCommand = useCallback((command) => {
    speakCommand(command)
  }, [])

  // ── Detection loop ────────────────────────────────────────────────────────
  const startDetectionLoop = useCallback(() => {
    const video          = videoRef.current
    const canvas         = canvasRef.current
    const poseLandmarker = poseLandmarkerRef.current
    const referee        = refereeRef.current

    if (!video || !canvas || !poseLandmarker || !referee) return

    const ctx          = canvas.getContext('2d')
    const drawingUtils = new DrawingUtils(ctx)

    const detect = () => {
      canvas.width  = video.videoWidth
      canvas.height = video.videoHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (video.readyState >= 2) {
        const results = poseLandmarker.detectForVideo(video, performance.now())

        if (results.landmarks && results.landmarks.length > 0) {
          const rawLandmarks = results.landmarks[0]

          // draw skeleton
          drawingUtils.drawConnectors(
            rawLandmarks,
            PoseLandmarker.POSE_CONNECTIONS,
            { color: '#00FF00', lineWidth: 2 }
          )
          drawingUtils.drawLandmarks(
            rawLandmarks,
            { color: '#FF0000', lineWidth: 1, radius: 3 }
          )

          // extract landmarks and run state machine
          const landmarks = extractLandmarks(rawLandmarks)
          const update    = referee.update(landmarks)

          // update status bar with rep count if set has started
          if (update.currentRep > 0) {
            setStatus(
              `Rep ${update.currentRep}/${totalReps} — ${stateMessages[update.state] ?? update.state}`
            )
          } else {
            setStatus(stateMessages[update.state] ?? update.state)
          }

          // when result first becomes non-pending, freeze rep results
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
          setStatus('READY — Stand in frame')
        }
      }

      animationFrameRef.current = requestAnimationFrame(detect)
    }

    detect()
  }, [totalReps, stateMessages])

  // ── Start camera ──────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    const attempts = [
      { video: { facingMode: 'user' } },
      { video: { facingMode: 'environment' } },
      { video: true }
    ]

    let lastError = null

    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        const video  = videoRef.current
        if (video) {
          video.srcObject = stream
          video.play().catch(() => {})
          video.onloadedmetadata = () => {
            setStatus('READY — Stand in frame')
            startDetectionLoop()
          }
        }
        return
      } catch (err) {
        lastError = err
        continue
      }
    }

    setCameraError(lastError.name + ': ' + lastError.message)
  }, [startDetectionLoop])

  // ── Load everything ───────────────────────────────────────────────────────
  useEffect(() => {
    const setup = async () => {
      await initAudio()

      // pick correct referee based on lift
      refereeRef.current = isDeadlift
        ? new DeadliftReferee(handleCommand, totalReps, angle)
        : new SquatReferee(handleCommand, totalReps)

      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        )

        poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numPoses: 1
        })

        await startCamera()

      } catch (err) {
        setCameraError('Failed to load: ' + err.message)
      }
    }

    setup()

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
      if (poseLandmarkerRef.current) poseLandmarkerRef.current.close()
    }
  }, [handleCommand, startCamera, totalReps, isDeadlift, angle])

  // ── Navigation handlers ───────────────────────────────────────────────────
  const handleBack = () => {
    navigate('/')
  }

  const handleDismiss = () => {
    setResult(LiftResult.PENDING)
    setRepResults([])
    repResultsRef.current = []
    checksRef.current     = []
    refereeRef.current?.reset()
    navigate('/')
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.container}>

      {/* Top bar */}
      <div style={styles.topBar}>
        <button onClick={handleBack} style={styles.backButton}>
          ← Back
        </button>
        <span style={styles.liftInfo}>
          {formatParam(liftId)} | {formatParam(angle)} | {totalReps} {totalReps === 1 ? 'rep' : 'reps'}
        </span>
      </div>

      {/* Camera area */}
      <div style={styles.cameraArea}>
        {cameraError ? (
          <p style={styles.errorText}>Error: {cameraError}</p>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={styles.video}
            />
            <canvas
              ref={canvasRef}
              style={styles.canvas}
            />
            {/* Result overlay - shows after final rep */}
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

      {/* Bottom status bar */}
      <StatusBar status={status} />

    </div>
  )
}

const styles = {
  container: {
    display:       'flex',
    flexDirection: 'column',
    height:        '100vh',
    background:    '#000',
  },
  topBar: {
    display:    'flex',
    alignItems: 'center',
    padding:    '12px 16px',
    background: '#111',
    gap:        '16px',
    flexShrink: 0,
  },
  backButton: {
    fontSize: '16px',
    color:    '#888',
  },
  liftInfo: {
    fontSize:   '14px',
    fontWeight: '500',
    color:      '#fff',
  },
  cameraArea: {
    flex:       1,
    position:   'relative',
    background: '#000',
    overflow:   'hidden',
  },
  video: {
    position:  'absolute',
    top:       0,
    left:      0,
    width:     '100%',
    height:    '100%',
    objectFit: 'cover',
  },
  canvas: {
    position: 'absolute',
    top:      0,
    left:     0,
    width:    '100%',
    height:   '100%',
  },
  errorText: {
    color:     'red',
    fontSize:  '14px',
    padding:   '16px',
    textAlign: 'center',
  }
}

export default CameraScreen
