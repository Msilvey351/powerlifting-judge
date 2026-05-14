// src/screens/CalibrationScreen.jsx
//
// Two-step calibration for bench press:
//   Step 1 — lifter holds bar at LOCKOUT  → records armExtendedDistance
//   Step 2 — lifter holds bar at CHEST    → records chestRatio
//
// URL: /calibrate/:liftId/:angle/:reps
// Navigates to /camera/:liftId/:angle/:reps on completion (or skip).

import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams }                   from 'react-router-dom'
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision'
import { extractLandmarks }                         from '../logic/poseUtils'
import { euclideanDistance, benchPickBestSide, computeElbowAngle } from '../logic/poseUtils'
import { saveBenchCalibration, listProfiles, getBenchCalibration } from '../logic/calibrationStore'

// ── Calibration state machine ─────────────────────────────────────────────────
const CalStep = {
  NAME:     'NAME',      // enter / select lifter name
  LOCKOUT:  'LOCKOUT',   // hold bar at lockout
  CHEST:    'CHEST',     // hold bar at chest
  DONE:     'DONE',      // saved
}

// How many frames of stillness needed to accept each hold
const HOLD_FRAMES_REQUIRED = 30
const VELOCITY_THRESHOLD   = 0.004
const ELBOW_LOCK_ANGLE     = 155  // slightly lower than judging threshold for robustness

export default function CalibrationScreen() {
  const navigate                  = useNavigate()
  const { liftId, angle, reps }   = useParams()

  // ── MediaPipe ─────────────────────────────────────────────────────────────
  const videoRef          = useRef(null)
  const canvasRef         = useRef(null)
  const poseLandmarkerRef = useRef(null)
  const animFrameRef      = useRef(null)

  // ── Calibration data ──────────────────────────────────────────────────────
  const armExtendedRef    = useRef(null)   // recorded at lockout
  const calSideRef        = useRef(null)   // which side we calibrated on

  // ── Frame-level mutable state (not React state — updated every frame) ─────
  const holdFramesRef     = useRef(0)
  const wristHistoryRef   = useRef([])

  // ── React state ───────────────────────────────────────────────────────────
  const [step,         setStep]        = useState(CalStep.NAME)
  const [lifterName,   setLifterName]  = useState('')
  const [nameInput,    setNameInput]   = useState('')
  const [existingProfiles, setExistingProfiles] = useState([])
  const [progress,     setProgress]    = useState(0)    // 0-1 for hold bar
  const [instruction,  setInstruction] = useState('')
  const [mpReady,      setMpReady]     = useState(false)
  const [cameraError,  setCameraError] = useState(null)
  const [existingCal,  setExistingCal] = useState(null)  // prior cal for this name

  // ── Load existing profiles on mount ──────────────────────────────────────
  useEffect(() => {
    setExistingProfiles(listProfiles())
  }, [])

  // ── Wrist velocity helper ─────────────────────────────────────────────────
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

  // ── Detection loop ────────────────────────────────────────────────────────
  const stepRef = useRef(step)
  useEffect(() => { stepRef.current = step }, [step])

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
          const raw       = results.landmarks[0]
          draw.drawConnectors(raw, PoseLandmarker.POSE_CONNECTIONS, { color: '#00FF00', lineWidth: 2 })
          draw.drawLandmarks(raw, { color: '#FF0000', lineWidth: 1, radius: 3 })

          const landmarks = extractLandmarks(raw)
          const side      = benchPickBestSide(landmarks)
          if (!side) {
            holdFramesRef.current = 0
            setProgress(0)
            setInstruction('Hold arms in frame')
            animFrameRef.current = requestAnimationFrame(loop)
            return
          }

          const elbowAngle = computeElbowAngle(landmarks, side)
          const velocity   = getWristVelocity(landmarks, side)
          const wristStill = velocity < VELOCITY_THRESHOLD
          const lockedOut  = elbowAngle >= ELBOW_LOCK_ANGLE

          const currentStep = stepRef.current

          // ── LOCKOUT step ──────────────────────────────────────────────────
          if (currentStep === CalStep.LOCKOUT) {
            if (lockedOut && wristStill) {
              holdFramesRef.current++
            } else {
              holdFramesRef.current = Math.max(0, holdFramesRef.current - 2)
            }

            const prog = Math.min(holdFramesRef.current / HOLD_FRAMES_REQUIRED, 1)
            setProgress(prog)
            setInstruction(
              lockedOut
                ? wristStill
                  ? `Hold still… ${Math.round(prog * 100)}%`
                  : 'Keep arms locked — hold still'
                : 'Lock out your arms fully'
            )

            if (holdFramesRef.current >= HOLD_FRAMES_REQUIRED) {
              // Record arm extended distance on the best side
              const shoulder     = landmarks[`${side}_shoulder`]
              const wrist        = landmarks[`${side}_wrist`]
              armExtendedRef.current = euclideanDistance(shoulder, wrist)
              calSideRef.current     = side

              console.log(`[Cal] Lockout recorded: armExtended=${armExtendedRef.current.toFixed(4)}, side=${side}`)

              holdFramesRef.current   = 0
              wristHistoryRef.current = []
              setProgress(0)
              setStep(CalStep.CHEST)
            }

          // ── CHEST step ────────────────────────────────────────────────────
          } else if (currentStep === CalStep.CHEST) {
            // For chest step, we don't require locked out — we require elbow bent
            const elbowBent = elbowAngle < 110
            if (elbowBent && wristStill) {
              holdFramesRef.current++
            } else {
              holdFramesRef.current = Math.max(0, holdFramesRef.current - 2)
            }

            const prog = Math.min(holdFramesRef.current / HOLD_FRAMES_REQUIRED, 1)
            setProgress(prog)
            setInstruction(
              elbowBent
                ? wristStill
                  ? `Hold still… ${Math.round(prog * 100)}%`
                  : 'Hold the bar on your chest — keep still'
                : 'Lower bar to chest and hold'
            )

            if (holdFramesRef.current >= HOLD_FRAMES_REQUIRED) {
              // Record chest ratio
              const calSide  = calSideRef.current
              const shoulder = landmarks[`${calSide}_shoulder`]
              const wrist    = landmarks[`${calSide}_wrist`]
              const armBentDistance = euclideanDistance(shoulder, wrist)
              const chestRatio      = armBentDistance / armExtendedRef.current

              console.log(`[Cal] Chest recorded: armBent=${armBentDistance.toFixed(4)}, ratio=${chestRatio.toFixed(3)}`)

              // Save to localStorage
              saveBenchCalibration(lifterName, {
                chestRatio,
                armExtendedDistance: armExtendedRef.current,
                side: calSideRef.current,
              })

              setStep(CalStep.DONE)
            }
          }
        } else {
          setInstruction('Stand/lie in frame')
          holdFramesRef.current = 0
          setProgress(0)
        }
      }

      animFrameRef.current = requestAnimationFrame(loop)
    }

    loop()
  }, [getWristVelocity, lifterName])

  // ── Start camera + MediaPipe when name is confirmed ───────────────────────
  useEffect(() => {
    if (step !== CalStep.LOCKOUT) return

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

        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
        const video  = videoRef.current
        if (video && !cancelled) {
          video.srcObject = stream
          await video.play()
          setMpReady(true)
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
  }, [step, runLoop])

  // ── Navigation ────────────────────────────────────────────────────────────
  const goToCamera = () => {
    navigate(`/camera/${liftId}/${angle}/${reps}?lifter=${encodeURIComponent(lifterName)}`)
  }

  const skipCalibration = () => {
    navigate(`/camera/${liftId}/${angle}/${reps}`)
  }

  // ── Name step handlers ────────────────────────────────────────────────────
  const confirmName = (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setLifterName(trimmed)
    const existing = getBenchCalibration(trimmed)
    setExistingCal(existing)
    setStep(CalStep.LOCKOUT)
    setInstruction('Lock out your arms fully')
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // NAME step — pick or enter name
  if (step === CalStep.NAME) {
    return (
      <div style={styles.container}>
        <div style={styles.panel}>
          <h2 style={styles.heading}>Bench Press Calibration</h2>
          <p style={styles.sub}>
            Calibration records your arm position at lockout and chest contact.
            Takes about 10 seconds.
          </p>

          {existingProfiles.length > 0 && (
            <div style={styles.section}>
              <p style={styles.label}>Existing lifters:</p>
              {existingProfiles.map(name => (
                <button
                  key={name}
                  style={styles.profileBtn}
                  onClick={() => confirmName(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          <div style={styles.section}>
            <p style={styles.label}>New lifter:</p>
            <input
              style={styles.input}
              placeholder="Enter name"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && confirmName(nameInput)}
            />
            <button
              style={styles.primaryBtn}
              onClick={() => confirmName(nameInput)}
            >
              Start Calibration
            </button>
          </div>

          <button style={styles.skipBtn} onClick={skipCalibration}>
            Skip — use elbow angle only
          </button>
        </div>
      </div>
    )
  }

  // DONE step
  if (step === CalStep.DONE) {
    return (
      <div style={styles.container}>
        <div style={styles.panel}>
          <h2 style={styles.heading}>✓ Calibrated</h2>
          <p style={styles.sub}>
            Chest position saved for <strong>{lifterName}</strong>.
          </p>
          <button style={styles.primaryBtn} onClick={goToCamera}>
            Start Lifting
          </button>
        </div>
      </div>
    )
  }

  // LOCKOUT / CHEST steps — camera view
  return (
    <div style={styles.container}>
      {/* Camera + skeleton overlay */}
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

      {/* Instruction panel */}
      <div style={styles.infoPanel}>
        <p style={styles.stepLabel}>
          {step === CalStep.LOCKOUT ? 'Step 1 of 2 — Lockout' : 'Step 2 of 2 — Chest'}
        </p>
        <p style={styles.instructionText}>{instruction}</p>

        {/* Progress bar */}
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${progress * 100}%` }} />
        </div>

        <button style={styles.skipBtn} onClick={skipCalibration}>
          Skip calibration
        </button>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  container: {
    display:        'flex',
    flexDirection:  'column',
    height:         '100vh',
    background:     '#000',
    color:          '#fff',
    alignItems:     'center',
    justifyContent: 'center',
  },
  panel: {
    padding:   '32px 24px',
    maxWidth:  '400px',
    width:     '100%',
  },
  heading: {
    fontSize:     '24px',
    fontWeight:   '700',
    marginBottom: '8px',
  },
  sub: {
    fontSize:     '14px',
    color:        '#aaa',
    marginBottom: '24px',
    lineHeight:   '1.5',
  },
  section: {
    marginBottom: '24px',
  },
  label: {
    fontSize:     '13px',
    color:        '#888',
    marginBottom: '8px',
  },
  profileBtn: {
    display:      'block',
    width:        '100%',
    padding:      '12px',
    marginBottom: '8px',
    background:   '#222',
    color:        '#fff',
    border:       '1px solid #444',
    borderRadius: '8px',
    fontSize:     '16px',
    cursor:       'pointer',
    textAlign:    'left',
  },
  input: {
    display:      'block',
    width:        '100%',
    padding:      '12px',
    marginBottom: '12px',
    background:   '#111',
    color:        '#fff',
    border:       '1px solid #444',
    borderRadius: '8px',
    fontSize:     '16px',
    boxSizing:    'border-box',
  },
  primaryBtn: {
    display:      'block',
    width:        '100%',
    padding:      '14px',
    background:   '#fff',
    color:        '#000',
    border:       'none',
    borderRadius: '8px',
    fontSize:     '16px',
    fontWeight:   '700',
    cursor:       'pointer',
  },
  skipBtn: {
    display:    'block',
    width:      '100%',
    padding:    '12px',
    marginTop:  '16px',
    background: 'transparent',
    color:      '#666',
    border:     'none',
    fontSize:   '14px',
    cursor:     'pointer',
  },
  cameraArea: {
    flex:       1,
    position:   'relative',
    width:      '100%',
    background: '#000',
    overflow:   'hidden',
  },
  video: {
    position:  'absolute',
    top: 0, left: 0,
    width:     '100%',
    height:    '100%',
    objectFit: 'cover',
  },
  canvas: {
    position:  'absolute',
    top: 0, left: 0,
    width:     '100%',
    height:    '100%',
  },
  infoPanel: {
    padding:    '20px 24px',
    background: '#111',
    flexShrink: 0,
    width:      '100%',
    boxSizing:  'border-box',
  },
  stepLabel: {
    fontSize:     '12px',
    color:        '#888',
    marginBottom: '4px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  instructionText: {
    fontSize:     '20px',
    fontWeight:   '600',
    marginBottom: '16px',
  },
  progressTrack: {
    height:       '6px',
    background:   '#333',
    borderRadius: '3px',
    overflow:     'hidden',
    marginBottom: '16px',
  },
  progressFill: {
    height:     '100%',
    background: '#4CAF50',
    transition: 'width 0.1s linear',
  },
  errorText: {
    color:    'red',
    padding:  '16px',
    fontSize: '14px',
  },
}