// src/screens/VideoAnalysisScreen.jsx
//
// Dev tool — upload a video file and run it through the same
// judging pipeline as the live camera screen.
//
// The video replaces getUserMedia. Everything downstream
// (MediaPipe, state machine, drawing, velocity, results) is identical.

import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate }                              from 'react-router-dom'
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision'
import { extractLandmarks, isVisible, LandmarkSmoother } from '../logic/poseUtils'
import { drawRelevantVisiblePose }                  from '../logic/drawingPolicy'
import { BarDetector }                              from '../logic/barDetector'
import { getCalibration }                           from '../logic/calibrationStore'
import { getUserProfile }                           from '../logic/userProfileStore'
import { initAudio, speakCommand }                  from '../logic/audio'
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
import { LIFTS }      from '../models/lifts'

// ── Setup screen ──────────────────────────────────────────────────────────────
function SetupPanel({ onStart }) {
  const [liftId,    setLiftId]    = useState('squat')
  const [angle,     setAngle]     = useState('side')
  const [reps,      setReps]      = useState('3')
  const [audioOn,   setAudioOn]   = useState(false)
  const [file,      setFile]      = useState(null)
  const [error,     setError]     = useState(null)

  const currentLift = LIFTS.find(l => l.id === liftId)

  const handleStart = () => {
    if (!file) { setError('Please select a video file'); return }

    const numReps = parseInt(reps, 10)
    if (!numReps || numReps < 1 || numReps > 20) {
      setError('Please enter a valid rep count (1–20)')
      return
    }

    setError(null)
    onStart({ liftId, angle, reps: numReps, file, audioOn })
  }

  return (
    <div style={setup.container}>
      <div style={setup.header}>
        <h1 style={setup.title}>Video Analysis</h1>
        <p style={setup.subtitle}>Dev tool — upload a video to judge</p>
      </div>

      <div style={setup.form}>

        {/* Lift */}
        <div style={setup.field}>
          <label style={setup.label}>Lift</label>
          <div style={setup.optionRow}>
            {LIFTS.map(l => (
              <button
                key={l.id}
                style={{
                  ...setup.optionBtn,
                  ...(liftId === l.id ? setup.optionBtnActive : {}),
                }}
                onClick={() => {
                  setLiftId(l.id)
                  setAngle(l.angles[0].toLowerCase())
                }}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>

        {/* Angle */}
        <div style={setup.field}>
          <label style={setup.label}>Camera Angle</label>
          <div style={setup.optionRow}>
            {currentLift?.angles.map(a => (
              <button
                key={a}
                style={{
                  ...setup.optionBtn,
                  ...(angle === a.toLowerCase() ? setup.optionBtnActive : {}),
                }}
                onClick={() => setAngle(a.toLowerCase())}
              >
                {a} View
              </button>
            ))}
          </div>
        </div>

        {/* Reps */}
        <div style={setup.field}>
          <label style={setup.label}>Rep count</label>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="20"
            value={reps}
            onChange={e => setReps(e.target.value)}
            style={setup.input}
          />
        </div>

        {/* Audio toggle */}
        <div style={setup.field}>
          <label style={setup.label}>Audio commands</label>
          <div style={setup.optionRow}>
            <button
              style={{
                ...setup.optionBtn,
                ...(audioOn ? setup.optionBtnActive : {}),
              }}
              onClick={() => setAudioOn(true)}
            >
              On
            </button>
            <button
              style={{
                ...setup.optionBtn,
                ...(!audioOn ? setup.optionBtnActive : {}),
              }}
              onClick={() => setAudioOn(false)}
            >
              Off
            </button>
          </div>
        </div>

        {/* File upload */}
        <div style={setup.field}>
          <label style={setup.label}>Video file</label>
          <label style={setup.fileLabel}>
            {file ? file.name : 'Tap to select video'}
            <input
              type="file"
              accept="video/*"
              style={{ display: 'none' }}
              onChange={e => {
                setFile(e.target.files[0] ?? null)
                setError(null)
              }}
            />
          </label>
          {file && (
            <p style={setup.fileName}>
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          )}
        </div>

        {error && <p style={setup.error}>{error}</p>}

        <button style={setup.startBtn} onClick={handleStart}>
          Analyse Video
        </button>

      </div>
    </div>
  )
}

// ── Analysis screen ───────────────────────────────────────────────────────────
function AnalysisPanel({ config, onBack }) {
  const { liftId, angle, reps: totalReps, file, audioOn } = config

  const videoRef          = useRef(null)
  const canvasRef         = useRef(null)
  const poseLandmarkerRef = useRef(null)
  const animFrameRef      = useRef(null)
  const refereeRef        = useRef(null)
  const barDetectorRef    = useRef(null)
  const repResultsRef     = useRef([])
  const smootherRef       = useRef(new LandmarkSmoother(5))
  const fileUrlRef        = useRef(null)

  const [status,      setStatus]      = useState('Loading...')
  const [result,      setResult]      = useState(LiftResult.PENDING)
  const [repResults,  setRepResults]  = useState([])
  const [loading,     setLoading]     = useState(true)
  const [loadError,   setLoadError]   = useState(null)
  const [isPlaying,   setIsPlaying]   = useState(false)
  const [loop,        setLoop]        = useState(false)

  const isBench    = liftId === 'bench'
  const isDeadlift = liftId === 'deadlift'

  const stateMessages = isBench    ? BENCH_STATE_MESSAGES
                      : isDeadlift ? DEADLIFT_STATE_MESSAGES
                      : STATE_MESSAGES

  function getVisibleWristY(landmarks) {
    const left  = landmarks.left_wrist
    const right = landmarks.right_wrist
    const lv = isVisible(left, 0.5)
    const rv = isVisible(right, 0.5)
    if (lv && rv) return (left.y + right.y) / 2
    if (lv) return left.y
    if (rv) return right.y
    return null
  }

  const handleCommand = useCallback((command) => {
    if (audioOn) speakCommand(command)
  }, [audioOn])

  // ── Detection loop ──────────────────────────────────────────────────────────
  const startDetectionLoop = useCallback(() => {
    const video          = videoRef.current
    const canvas         = canvasRef.current
    const poseLandmarker = poseLandmarkerRef.current
    const referee        = refereeRef.current

    if (!video || !canvas || !poseLandmarker || !referee) return

    const ctx          = canvas.getContext('2d')
    const drawingUtils = new DrawingUtils(ctx)

    const detect = () => {
      // Stop loop if video ended and not looping
      if (video.ended && !loop) {
        cancelAnimationFrame(animFrameRef.current)
        return
      }

      canvas.width  = video.videoWidth  || 720
      canvas.height = video.videoHeight || 1280
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (video.readyState >= 2 && !video.paused && !video.ended) {
        // Use video.currentTime * 1000 for accurate timestamps with uploaded video
        const results = poseLandmarker.detectForVideo(
          video,
          video.currentTime * 1000
        )

        if (results.landmarks && results.landmarks.length > 0) {
          const rawLandmarks = results.landmarks[0]
          const landmarks    = smootherRef.current.smooth(
            extractLandmarks(rawLandmarks)
          )

          let barY = null
          if (isBench && barDetectorRef.current) {
            const wristY = getVisibleWristY(landmarks)
            barY = barDetectorRef.current.processFrame(video, wristY)
          }

          const update = isBench
            ? referee.update(landmarks, barY)
            : referee.update(landmarks)

          drawRelevantVisiblePose({
            drawingUtils,
            rawLandmarks,
            liftId,
            angle,
            update,
            landmarkStyle:  { color: '#FF0000', lineWidth: 1, radius: 3 },
            connectorStyle: { color: '#00FF00', lineWidth: 2 },
            visibilityThreshold: 0.5,
          })

          const statusText = update.currentRep > 0
            ? `Rep ${update.currentRep}/${totalReps} — ${stateMessages[update.state] ?? update.state}`
            : stateMessages[update.state] ?? update.state

          setStatus(statusText)

          if (update.result !== LiftResult.PENDING) {
            setResult(prev => {
              if (prev === LiftResult.PENDING) {
                repResultsRef.current = update.repResults
                setRepResults(update.repResults)
              }
              return update.result
            })
          }

        } else {
          setStatus('No pose detected')
        }
      }

      animFrameRef.current = requestAnimationFrame(detect)
    }

    detect()
  }, [totalReps, stateMessages, isBench, liftId, angle, loop])

  // ── Load everything ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        await initAudio()

        const userProfile = getUserProfile()

        if (isBench) {
          const calibration  = getCalibration('bench', angle.toLowerCase())
          refereeRef.current = new BenchReferee(
            handleCommand, totalReps, angle, calibration, userProfile
          )
          barDetectorRef.current = new BarDetector()
        } else if (isDeadlift) {
          refereeRef.current = new DeadliftReferee(
            handleCommand, totalReps, angle, 30, 0.02, userProfile
          )
        } else {
          refereeRef.current = new SquatReferee(
            handleCommand, totalReps, angle, userProfile
          )
        }

        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        )

        poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numPoses: 1,
        })

        if (cancelled) return

        const url = URL.createObjectURL(file)
        fileUrlRef.current = url

        const video = videoRef.current
        if (video && !cancelled) {
          video.src  = url
          video.loop = false

          video.onloadedmetadata = () => {
            setLoading(false)
            setStatus('Press play to begin analysis')
          }

          video.onerror = () => {
            setLoadError('Could not load video file')
          }
        }

      } catch (err) {
        if (!cancelled) setLoadError('Failed to load: ' + err.message)
      }
    }

    load()

    return () => {
      cancelled = true
      if (animFrameRef.current)  cancelAnimationFrame(animFrameRef.current)
      if (poseLandmarkerRef.current) poseLandmarkerRef.current.close()
      if (barDetectorRef.current)    barDetectorRef.current.dispose()
      if (fileUrlRef.current)        URL.revokeObjectURL(fileUrlRef.current)
    }
  }, [
    file, isBench, isDeadlift, angle,
    totalReps, handleCommand,
  ])

  // ── Sync loop toggle to video element ───────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current
    if (video) video.loop = loop
  }, [loop])

  // ── Play / Pause ────────────────────────────────────────────────────────────
  const handlePlayPause = () => {
    const video = videoRef.current
    if (!video) return

    if (video.paused || video.ended) {
      // If ended and not looping, restart
      if (video.ended) {
        video.currentTime = 0
        refereeRef.current?.reset()
        smootherRef.current.reset()
        setResult(LiftResult.PENDING)
        setRepResults([])
        repResultsRef.current = []
      }

      video.play()
      setIsPlaying(true)
      startDetectionLoop()
    } else {
      video.pause()
      setIsPlaying(false)
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
    }
  }

  const handleDismiss = () => {
    const video = videoRef.current
    if (video) {
      video.pause()
      video.currentTime = 0
    }
    setResult(LiftResult.PENDING)
    setRepResults([])
    repResultsRef.current = []
    refereeRef.current?.reset()
    smootherRef.current.reset()
    setIsPlaying(false)
    setStatus('Press play to begin analysis')
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div style={analysis.errorContainer}>
        <p style={analysis.errorText}>{loadError}</p>
        <button style={analysis.backBtn} onClick={onBack}>← Back</button>
      </div>
    )
  }

  return (
    <div style={analysis.container}>

      {/* Top bar */}
      <div style={analysis.topBar}>
        <button onClick={onBack} style={analysis.backBtn}>← Back</button>
        <span style={analysis.liftInfo}>
          {liftId.charAt(0).toUpperCase() + liftId.slice(1)} | {angle.charAt(0).toUpperCase() + angle.slice(1)} | {totalReps} reps
        </span>
        <span style={analysis.devBadge}>DEV</span>
      </div>

      {/* Video + canvas area */}
      <div style={analysis.videoArea}>
        {loading && (
          <div style={analysis.loadingOverlay}>
            <p style={analysis.loadingText}>Loading model...</p>
          </div>
        )}

        <video
          ref={videoRef}
          playsInline
          muted
          style={analysis.video}
        />
        <canvas
          ref={canvasRef}
          style={analysis.canvas}
        />

        {result !== LiftResult.PENDING && (
          <ResultsOverlay
            repResults={repResults}
            totalReps={totalReps}
            onDismiss={handleDismiss}
          />
        )}
      </div>

      {/* Controls */}
      <div style={analysis.controls}>
        <button
          onClick={handlePlayPause}
          style={analysis.playBtn}
          disabled={loading}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>

        <button
          onClick={() => setLoop(l => !l)}
          style={{
            ...analysis.loopBtn,
            ...(loop ? analysis.loopBtnActive : {}),
          }}
        >
          ↻ Loop {loop ? 'On' : 'Off'}
        </button>
      </div>

      {/* Status bar */}
      <StatusBar status={status} />

    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function VideoAnalysisScreen() {
  const navigate = useNavigate()
  const [config, setConfig] = useState(null)

  if (!config) {
    return (
      <SetupPanel
        onStart={cfg => setConfig(cfg)}
      />
    )
  }

  return (
    <AnalysisPanel
      config={config}
      onBack={() => {
        setConfig(null)
      }}
    />
  )
}

// ── Setup styles ──────────────────────────────────────────────────────────────
const setup = {
  container: {
    display:       'flex',
    flexDirection: 'column',
    minHeight:     '100vh',
    padding:       '24px 16px',
    background:    '#000',
    color:         '#fff',
  },
  header: {
    marginBottom: '32px',
    marginTop:    '20px',
  },
  title: {
    fontSize:     '28px',
    fontWeight:   '700',
    marginBottom: '8px',
  },
  subtitle: {
    fontSize: '14px',
    color:    '#888',
  },
  form: {
    display:       'flex',
    flexDirection: 'column',
    gap:           '24px',
  },
  field: {
    display:       'flex',
    flexDirection: 'column',
    gap:           '10px',
  },
  label: {
    fontSize:   '13px',
    color:      '#888',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  optionRow: {
    display: 'flex',
    gap:     '8px',
    flexWrap: 'wrap',
  },
  optionBtn: {
    padding:      '10px 16px',
    background:   '#1a1a1a',
    color:        '#aaa',
    border:       '1px solid #333',
    borderRadius: '8px',
    fontSize:     '14px',
    cursor:       'pointer',
  },
  optionBtnActive: {
    background: '#fff',
    color:      '#000',
    border:     '1px solid #fff',
    fontWeight: '600',
  },
  input: {
    padding:      '14px',
    fontSize:     '22px',
    fontWeight:   '700',
    textAlign:    'center',
    background:   '#1a1a1a',
    border:       '1px solid #333',
    borderRadius: '10px',
    color:        '#fff',
    width:        '100px',
    outline:      'none',
  },
  fileLabel: {
    display:      'block',
    padding:      '16px',
    background:   '#1a1a1a',
    border:       '1px dashed #444',
    borderRadius: '10px',
    color:        '#888',
    fontSize:     '15px',
    cursor:       'pointer',
    textAlign:    'center',
  },
  fileName: {
    fontSize: '12px',
    color:    '#666',
    margin:   0,
  },
  error: {
    color:    '#cc4444',
    fontSize: '13px',
    margin:   0,
  },
  startBtn: {
    padding:      '16px',
    background:   '#fff',
    color:        '#000',
    border:       'none',
    borderRadius: '12px',
    fontSize:     '16px',
    fontWeight:   '700',
    cursor:       'pointer',
    marginTop:    '8px',
  },
}

// ── Analysis styles ───────────────────────────────────────────────────────────
const analysis = {
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
    gap:        '12px',
    flexShrink: 0,
  },
  backBtn: {
    fontSize:     '14px',
    color:        '#888',
    background:   'transparent',
    border:       'none',
    cursor:       'pointer',
    padding:      0,
  },
  liftInfo: {
    fontSize:   '14px',
    fontWeight: '500',
    color:      '#fff',
    flex:       1,
  },
  devBadge: {
    fontSize:     '10px',
    fontWeight:   '700',
    color:        '#f5a623',
    border:       '1px solid #f5a623',
    borderRadius: '4px',
    padding:      '2px 6px',
  },
  videoArea: {
    flex:       1,
    position:   'relative',
    background: '#000',
    overflow:   'hidden',
  },
  loadingOverlay: {
    position:       'absolute',
    inset:          0,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    background:     'rgba(0,0,0,0.7)',
    zIndex:         5,
  },
  loadingText: {
    color:    '#fff',
    fontSize: '16px',
  },
  video: {
    position:  'absolute',
    top:       0,
    left:      0,
    width:     '100%',
    height:    '100%',
    objectFit: 'contain',
    background: '#000',
  },
  canvas: {
    position: 'absolute',
    top:      0,
    left:     0,
    width:    '100%',
    height:   '100%',
  },
  controls: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '12px',
    padding:        '14px 16px',
    background:     '#111',
    flexShrink:     0,
  },
  playBtn: {
    padding:      '12px 32px',
    background:   '#fff',
    color:        '#000',
    border:       'none',
    borderRadius: '10px',
    fontSize:     '15px',
    fontWeight:   '700',
    cursor:       'pointer',
  },
  loopBtn: {
    padding:      '12px 20px',
    background:   '#1a1a1a',
    color:        '#888',
    border:       '1px solid #333',
    borderRadius: '10px',
    fontSize:     '14px',
    cursor:       'pointer',
  },
  loopBtnActive: {
    background: '#1a3a1a',
    color:      '#4CAF50',
    border:     '1px solid #4CAF50',
  },
  errorContainer: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    height:         '100vh',
    background:     '#000',
    gap:            '20px',
  },
  errorText: {
    color:    '#cc4444',
    fontSize: '16px',
  },
}




