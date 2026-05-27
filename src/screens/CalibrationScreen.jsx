// src/screens/CalibrationScreen.jsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams }                   from 'react-router-dom'
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision'
import { extractLandmarks, euclideanDistance,
         benchPickBestSide, computeElbowAngle }     from '../logic/poseUtils'
import { saveCalibration, getCalibration }          from '../logic/calibrationStore'

// ── Constants ─────────────────────────────────────────────────────────────────
const TOTAL_REPS        = 3
const HOLD_FRAMES       = 20    // frames still needed to confirm lockout or chest
const VELOCITY_THRESH   = 0.005
const ELBOW_LOCK_ANGLE  = 155
const ELBOW_CHEST_ANGLE = 110   // below this = bar is approaching chest

// ── Calibration state machine states ─────────────────────────────────────────
const CalState = {
  LOADING:    'LOADING',     // mediapipe not ready yet
  WAITING:    'WAITING',     // waiting for lifter to get into position
  LOCKOUT:    'LOCKOUT',     // holding at lockout
  DESCENDING: 'DESCENDING',  // bar going down
  CHEST:      'CHEST',       // holding at chest
  ASCENDING:  'ASCENDING',   // bar going up
  DONE:       'DONE',        // all 3 reps recorded
}

export default function CalibrationScreen() {
  const navigate                = useNavigate()
  const { liftId, angle, reps } = useParams()
  const view                    = angle.toLowerCase()

  // ── MediaPipe refs ────────────────────────────────────────────────────────
  const videoRef          = useRef(null)
  const canvasRef         = useRef(null)
  const poseLandmarkerRef = useRef(null)
  const animFrameRef      = useRef(null)

  // ── Calibration data refs (mutated each frame, not React state) ───────────
  const calStateRef       = useRef(CalState.LOADING)
  const holdFramesRef     = useRef(0)
  const wristHistoryRef   = useRef([])
  const lockoutSamplesRef = useRef([])   // armExtended per rep
  const chestSamplesRef   = useRef([])   // armBent per rep
  const repCountRef       = useRef(0)
  const calSideRef        = useRef(null)

  // ── React state (UI only) ─────────────────────────────────────────────────
  const [uiState,      setUiState]      = useState(CalState.LOADING)
  const [instruction,  setInstruction]  = useState('Loading camera...')
  const [repCount,     setRepCount]     = useState(0)
  const [progress,     setProgress]     = useState(0)
  const [cameraError,  setCameraError]  = useState(null)
  const [existingCal,  setExistingCal]  = useState(null)
  const [savedRatio,   setSavedRatio]   = useState(null)

  // Check for existing calibration on mount
  useEffect(() => {
    const cal = getCalibration(liftId, view)
    if (cal) {
      setExistingCal(cal)
    }
  }, [liftId, view])

  // ── Wrist velocity ────────────────────────────────────────────────────────
  const getWristVelocity = useCallback((landmarks, side) => {
    const wrist = landmarks[`${side}_wrist`]
    if (!wrist) return Infinity
    const hist = wristHistoryRef.current
    hist.push({ x: wrist.x, y: wrist.y })
    if (hist.length > 5) hist.shift()
    if (hist.length < 2) return Infinity
    const prev = hist[hist.length - 2]
    const curr = hist[hist.length - 1]
    return Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2)
  }, [])

  // ── Main detection loop ───────────────────────────────────────────────────
  const runLoop = useCallback(() => {
    const video  = videoRef.current
    const canvas = canvasRef.current
    const lm     = poseLandmarkerRef.current
    if (!video || !canvas || !lm) return

    const ctx  = canvas.getContext('2d')
    const draw = new DrawingUtils(ctx)

    const loop = () => {
      canvas.width  = video.videoWidth
      canvas.height = video.videoHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (video.readyState >= 2) {
        const results = lm.detectForVideo(video, performance.now())

        if (results.landmarks?.length > 0) {
          const raw = results.landmarks[0]
          draw.drawConnectors(raw, PoseLandmarker.POSE_CONNECTIONS,
            { color: '#00FF00', lineWidth: 2 })
          draw.drawLandmarks(raw,
            { color: '#FF0000', lineWidth: 1, radius: 3 })

          const landmarks = extractLandmarks(raw)
          const side      = benchPickBestSide(landmarks)

          if (!side) {
            setInstruction('Hold arms in frame')
            animFrameRef.current = requestAnimationFrame(loop)
            return
          }

          // Lock side for consistency across all reps
          if (!calSideRef.current) calSideRef.current = side

          const elbowAngle    = computeElbowAngle(landmarks, calSideRef.current)
          const velocity      = getWristVelocity(landmarks, calSideRef.current)
          const wristStill    = velocity < VELOCITY_THRESH
          const lockedOut     = elbowAngle >= ELBOW_LOCK_ANGLE
          const nearChest     = elbowAngle < ELBOW_CHEST_ANGLE
          const currentState  = calStateRef.current

          const shoulder = landmarks[`${calSideRef.current}_shoulder`]
          const wrist    = landmarks[`${calSideRef.current}_wrist`]
          const armDist  = euclideanDistance(shoulder, wrist)

          // ── State transitions ─────────────────────────────────────────────

          if (currentState === CalState.WAITING) {
            setInstruction('Lock out your arms to begin')
            if (lockedOut) {
              calStateRef.current = CalState.LOCKOUT
              holdFramesRef.current = 0
            }

          } else if (currentState === CalState.LOCKOUT) {
            if (!lockedOut) {
              holdFramesRef.current = 0
              setInstruction('Hold arms fully locked out')
            } else if (wristStill) {
              holdFramesRef.current++
              const prog = Math.min(holdFramesRef.current / HOLD_FRAMES, 1)
              setProgress(prog)
              setInstruction(`Hold… ${Math.round(prog * 100)}%`)

              if (holdFramesRef.current >= HOLD_FRAMES) {
                // Record lockout distance for this rep
                lockoutSamplesRef.current.push(armDist)
                holdFramesRef.current  = 0
                wristHistoryRef.current = []
                calStateRef.current    = CalState.DESCENDING
                setProgress(0)
                setInstruction('Lower bar to chest')
              }
            } else {
              holdFramesRef.current = Math.max(0, holdFramesRef.current - 1)
            }

          } else if (currentState === CalState.DESCENDING) {
            setInstruction('Lower bar to chest')
            if (nearChest && wristStill) {
              calStateRef.current   = CalState.CHEST
              holdFramesRef.current = 0
            }

          } else if (currentState === CalState.CHEST) {
            if (!nearChest) {
              // bar moved back up before we confirmed — go back
              calStateRef.current   = CalState.DESCENDING
              holdFramesRef.current = 0
            } else if (wristStill) {
              holdFramesRef.current++
              const prog = Math.min(holdFramesRef.current / HOLD_FRAMES, 1)
              setProgress(prog)
              setInstruction(`Hold at chest… ${Math.round(prog * 100)}%`)

              if (holdFramesRef.current >= HOLD_FRAMES) {
                // Record chest distance for this rep
                chestSamplesRef.current.push(armDist)
                holdFramesRef.current  = 0
                wristHistoryRef.current = []
                calStateRef.current    = CalState.ASCENDING
                setProgress(0)
                setInstruction('Press back up to lockout')
              }
            } else {
              holdFramesRef.current = Math.max(0, holdFramesRef.current - 1)
            }

          } else if (currentState === CalState.ASCENDING) {
            setInstruction('Press back up to lockout')
            if (lockedOut) {
              const newRepCount = repCountRef.current + 1
              repCountRef.current = newRepCount
              setRepCount(newRepCount)

              if (newRepCount >= TOTAL_REPS) {
                // All reps done — compute averages and save
                const avgExtended = lockoutSamplesRef.current.reduce((a, b) => a + b, 0)
                                    / lockoutSamplesRef.current.length
                const avgBent     = chestSamplesRef.current.reduce((a, b) => a + b, 0)
                                    / chestSamplesRef.current.length
                const chestRatio  = avgBent / avgExtended

                saveCalibration(liftId, view, {
                  chestRatio,
                  armExtendedDistance: avgExtended,
                })

                setSavedRatio(chestRatio)
                calStateRef.current = CalState.DONE
                setUiState(CalState.DONE)

                console.log(`[Cal] Done. ratio=${chestRatio.toFixed(3)}, extended=${avgExtended.toFixed(3)}`)
              } else {
                // More reps needed
                calStateRef.current   = CalState.LOCKOUT
                holdFramesRef.current = 0
                wristHistoryRef.current = []
              }
            }
          }

          // Sync UI state for instruction panel
          setUiState(calStateRef.current)

        } else {
          setInstruction('Get into position')
        }
      }

      animFrameRef.current = requestAnimationFrame(loop)
    }

    loop()
  }, [getWristVelocity, liftId, view])

  // ── Load MediaPipe + camera ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    const start = async () => {
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
          numPoses: 1,
        })

        if (cancelled) return

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' }
        })
        const video = videoRef.current
        if (video && !cancelled) {
          video.srcObject = stream
          await video.play()
          calStateRef.current = CalState.WAITING
          setUiState(CalState.WAITING)
          setInstruction('Lock out your arms to begin')
          runLoop()
        }
      } catch (err) {
        setCameraError(err.message)
      }
    }

    start()

    return () => {
      cancelled = true
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      if (poseLandmarkerRef.current) poseLandmarkerRef.current.close()
    }
  }, [runLoop])

  // ── Navigation ────────────────────────────────────────────────────────────
  const goToCamera = () => {
    navigate(`/camera/${liftId}/${angle}/${reps}`)
  }

  const skipCalibration = () => {
    navigate(`/camera/${liftId}/${angle}/${reps}`)
  }

  // ── DONE screen ───────────────────────────────────────────────────────────
  if (uiState === CalState.DONE) {
    return (
      <div style={styles.container}>
        <div style={styles.panel}>
          <h2 style={styles.heading}>✓ Calibrated</h2>
          <p style={styles.sub}>
            {TOTAL_REPS}-rep average saved for{' '}
            <strong>Bench Press — {angle} view</strong>.
          </p>
          {savedRatio && (
            <p style={styles.ratioText}>
              Chest ratio: {(savedRatio * 100).toFixed(1)}%
            </p>
          )}
          <button style={styles.primaryBtn} onClick={goToCamera}>
            Start Lifting
          </button>
          <button style={styles.skipBtn} onClick={() => {
            // Redo calibration
            repCountRef.current       = 0
            lockoutSamplesRef.current = []
            chestSamplesRef.current   = []
            calSideRef.current        = null
            holdFramesRef.current     = 0
            wristHistoryRef.current   = []
            calStateRef.current       = CalState.WAITING
            setRepCount(0)
            setProgress(0)
            setUiState(CalState.WAITING)
            setSavedRatio(null)
          }}>
            Redo calibration
          </button>
        </div>
      </div>
    )
  }

  // ── Camera + instruction screen ───────────────────────────────────────────
  return (
    <div style={styles.container}>
      <div style={styles.cameraArea}>
        {cameraError ? (
          <p style={styles.errorText}>{cameraError}</p>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
            <canvas ref={canvasRef} style={styles.canvas} />
          </>
        )}
      </div>

      <div style={styles.infoPanel}>
        {/* Header */}
        <div style={styles.headerRow}>
          <div>
            <p style={styles.stepLabel}>
              Bench Press — {angle} View Calibration
            </p>
            <p style={styles.repCounter}>
              Rep {Math.min(repCount + 1, TOTAL_REPS)} of {TOTAL_REPS}
            </p>
          </div>
          {existingCal && (
            <p style={styles.existingLabel}>
              Existing cal: {(existingCal.chestRatio * 100).toFixed(1)}%
            </p>
          )}
        </div>

        {/* Instruction */}
        <p style={styles.instructionText}>{instruction}</p>

        {/* Progress bar — shows during holds */}
        {progress > 0 && (
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${progress * 100}%` }} />
          </div>
        )}

        {/* Rep dots */}
        <div style={styles.repDots}>
          {Array.from({ length: TOTAL_REPS }).map((_, i) => (
            <div
              key={i}
              style={{
                ...styles.dot,
                background: i < repCount ? '#4CAF50' : '#333',
              }}
            />
          ))}
        </div>

        <button style={styles.skipBtn} onClick={skipCalibration}>
          Skip — use elbow angle only
        </button>
      </div>
    </div>
  )
}

const styles = {
  container:       { display: 'flex', flexDirection: 'column', height: '100vh', background: '#000', color: '#fff' },
  panel:           { padding: '40px 24px', maxWidth: '400px', width: '100%', margin: '0 auto' },
  heading:         { fontSize: '28px', fontWeight: '700', marginBottom: '8px' },
  sub:             { fontSize: '15px', color: '#aaa', marginBottom: '8px', lineHeight: '1.5' },
  ratioText:       { fontSize: '13px', color: '#666', marginBottom: '32px' },
  primaryBtn:      { display: 'block', width: '100%', padding: '16px', background: '#fff', color: '#000', border: 'none', borderRadius: '12px', fontSize: '17px', fontWeight: '700', cursor: 'pointer', marginBottom: '12px' },
  skipBtn:         { display: 'block', width: '100%', padding: '12px', background: 'transparent', color: '#666', border: 'none', fontSize: '14px', cursor: 'pointer', marginTop: '8px' },
  cameraArea:      { flex: 1, position: 'relative', background: '#000', overflow: 'hidden' },
  video:           { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' },
  canvas:          { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  infoPanel:       { padding: '20px 24px 28px', background: '#111', flexShrink: 0 },
  headerRow:       { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' },
  stepLabel:       { fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' },
  repCounter:      { fontSize: '15px', fontWeight: '600' },
  existingLabel:   { fontSize: '12px', color: '#555' },
  instructionText: { fontSize: '22px', fontWeight: '600', marginBottom: '16px' },
  progressTrack:   { height: '6px', background: '#333', borderRadius: '3px', overflow: 'hidden', marginBottom: '16px' },
  progressFill:    { height: '100%', background: '#4CAF50', transition: 'width 0.1s linear' },
  repDots:         { display: 'flex', gap: '8px', marginBottom: '16px' },
  dot:             { width: '12px', height: '12px', borderRadius: '50%' },
  errorText:       { color: 'red', padding: '16px', fontSize: '14px' },
}