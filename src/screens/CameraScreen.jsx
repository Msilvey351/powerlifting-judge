import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams }                   from 'react-router-dom'
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision'
import { initAudio, speakCommand }   from '../logic/audio'
import { drawRelevantVisiblePose }   from '../logic/drawingPolicy'
import { BarDetector }               from '../logic/barDetector'
import { SetRecorder }               from '../logic/setRecorder'
import { getCalibration }            from '../logic/calibrationStore'
import { getUserProfile }            from '../logic/userProfileStore'
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
import { extractLandmarks, isVisible, LandmarkSmoother } from '../logic/poseUtils'

function CameraScreen() {
  const landmarkSmootherRef = useRef(new LandmarkSmoother(5))
  const navigate                = useNavigate()
  const { liftId, angle, reps } = useParams()

  const videoRef          = useRef(null)
  const canvasRef         = useRef(null)
  const poseLandmarkerRef = useRef(null)
  const animationFrameRef = useRef(null)
  const refereeRef        = useRef(null)
  const barDetectorRef    = useRef(null)
  const repResultsRef     = useRef([])
  const streamRef         = useRef(null)

  // Recording refs
  const setRecorderRef       = useRef(null)
  const recordingFinalizedRef = useRef(false)

  const [status,      setStatus]      = useState('Loading pose detection...')
  const [cameraError, setCameraError] = useState(null)
  const [result,      setResult]      = useState(LiftResult.PENDING)
  const [repResults,  setRepResults]  = useState([])
  const [facingMode,  setFacingMode]  = useState('user')

  const [recordEnabled, setRecordEnabled] = useState(false)
  const [recordingState, setRecordingState] = useState('idle') // idle | recording | finalizing | ready | error
  const [recordingUrl, setRecordingUrl] = useState(null)
  const [recordingFilename, setRecordingFilename] = useState('set-recording.webm')
  const [recordingError, setRecordingError] = useState(null)

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

  function getVisibleWristYForBarRoi(landmarks) {
    const left  = landmarks.left_wrist
    const right = landmarks.right_wrist

    const leftVisible  = isVisible(left, 0.5)
    const rightVisible = isVisible(right, 0.5)

    if (leftVisible && rightVisible) {
      return (left.y + right.y) / 2
    }

    if (leftVisible) return left.y
    if (rightVisible) return right.y

    return null
  }

  const stopCurrentStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
  }, [])

  const stopRecorder = useCallback(() => {
    if (setRecorderRef.current?.isRecording()) {
      setRecorderRef.current.stop()
    }
  }, [])

  const startRecorder = useCallback(async () => {
    const video = videoRef.current
    if (!video) {
      setRecordingError('Camera not ready')
      setRecordingState('error')
      return
    }

    if (!window.MediaRecorder) {
      setRecordingError('Recording is not supported in this browser')
      setRecordingState('error')
      return
    }

    const width  = video.videoWidth  || 1280
    const height = video.videoHeight || 720

    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl)
      setRecordingUrl(null)
    }

    recordingFinalizedRef.current = false

    const filename = `${liftId}-${angle}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`

    const recorder = new SetRecorder({
      fps: 30,
      onStop: ({ url, filename: stoppedFilename }) => {
        setRecordingUrl(url)
        setRecordingFilename(stoppedFilename || filename)
        setRecordingState('ready')
        setRecordEnabled(false)
      },
      onError: (err) => {
        console.warn('[CameraScreen] Recorder error:', err)
        setRecordingError('Recording failed')
        setRecordingState('error')
        setRecordEnabled(false)
      },
    })

    try {
      await recorder.start({
        width,
        height,
        includeAudio: true,
        filename,
      })

      setRecorderRef.current = recorder
      setRecordingState('recording')
      setRecordingError(null)
      setRecordEnabled(true)
    } catch (err) {
      console.warn('[CameraScreen] Could not start recorder:', err)
      setRecordingError(err.message)
      setRecordingState('error')
      setRecordEnabled(false)
    }
  }, [angle, liftId, recordingUrl])

  const finalizeRecording = useCallback(({
    video,
    rawLandmarks,
    update,
    statusText,
    finalRepResults,
  }) => {
    const recorder = setRecorderRef.current
    if (!recorder?.isRecording()) return
    if (recordingFinalizedRef.current) return

    recordingFinalizedRef.current = true
    setRecordingState('finalizing')

    const startTime = performance.now()
    const durationMs = 4000

    const drawSummaryLoop = () => {
      if (!recorder.isRecording()) return

      recorder.drawSummary({
        video,
        rawLandmarks,
        liftId,
        angle,
        update,
        statusText: statusText || 'SET COMPLETE',
        repResults: finalRepResults,
        totalReps,
      })

      const elapsed = performance.now() - startTime

      if (elapsed < durationMs) {
        requestAnimationFrame(drawSummaryLoop)
      } else {
        recorder.stop()
      }
    }

    drawSummaryLoop()
  }, [angle, liftId, totalReps])

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
      canvas.width  = video.videoWidth
      canvas.height = video.videoHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (video.readyState >= 2) {
        const results = poseLandmarker.detectForVideo(video, performance.now())

        if (results.landmarks && results.landmarks.length > 0) {
          const rawLandmarks = results.landmarks[0]
          const landmarks    = landmarkSmootherRef.current.smooth(extractLandmarks(rawLandmarks))

          let barY = null
          if (isBench && barDetectorRef.current) {
            const wristY = getVisibleWristYForBarRoi(landmarks)
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

          let statusText
          if (update.currentRep > 0) {
            statusText = `Rep ${update.currentRep}/${totalReps} — ${stateMessages[update.state] ?? update.state}`
          } else {
            statusText = stateMessages[update.state] ?? update.state
          }

          setStatus(statusText)

          // Draw live frame into recording
          if (
            recordEnabled &&
            setRecorderRef.current?.isRecording() &&
            !recordingFinalizedRef.current
          ) {
            setRecorderRef.current.drawFrame({
              video,
              rawLandmarks,
              liftId,
              angle,
              update,
              statusText,
            })
          }

          if (update.result !== LiftResult.PENDING) {
            setResult(prev => {
              if (prev === LiftResult.PENDING) {
                console.log('FINAL REP RESULTS:', update.repResults)

                repResultsRef.current = update.repResults
                setRepResults(update.repResults)

                if (setRecorderRef.current?.isRecording()) {
                  finalizeRecording({
                    video,
                    rawLandmarks,
                    update,
                    statusText: 'SET COMPLETE',
                    finalRepResults: update.repResults,
                  })
                }
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
  }, [
    totalReps,
    stateMessages,
    isBench,
    liftId,
    angle,
    recordEnabled,
    finalizeRecording,
  ])

  // ── Start camera ────────────────────────────────────────────────────────────
  const startCamera = useCallback(async (preferredFacingMode = 'user') => {
    stopCurrentStream()

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    setCameraError(null)

    const attempts = [
      { video: { facingMode: { exact: preferredFacingMode } } },
      { video: { facingMode: preferredFacingMode } },
      {
        video: {
          facingMode: preferredFacingMode === 'user'
            ? 'environment'
            : 'user'
        }
      },
      { video: true },
    ]

    let lastError = null

    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        streamRef.current = stream

        const video = videoRef.current

        if (video) {
          video.srcObject = stream

          const actualFacingMode =
            stream.getVideoTracks()[0]?.getSettings?.().facingMode

          if (actualFacingMode === 'user' || actualFacingMode === 'environment') {
            setFacingMode(actualFacingMode)
          } else {
            setFacingMode(preferredFacingMode)
          }

          video.play().catch(() => {})

          video.onloadedmetadata = () => {
            setStatus('READY — Get into position')
            startDetectionLoop()
          }
        }

        return
      } catch (err) {
        lastError = err
      }
    }

    setCameraError(lastError?.name + ': ' + lastError?.message)
  }, [startDetectionLoop, stopCurrentStream])

  // ── Load everything ─────────────────────────────────────────────────────────
  useEffect(() => {
    const setup = async () => {
      await initAudio()

      const userProfile = getUserProfile()

      if (isBench) {
        const calibration      = getCalibration('bench', angle.toLowerCase())
        refereeRef.current     = new BenchReferee(handleCommand, totalReps, angle, calibration, userProfile)
        barDetectorRef.current = new BarDetector()
      } else if (isDeadlift) {
        refereeRef.current = new DeadliftReferee(handleCommand, totalReps, angle, 30, 0.02, userProfile)
      } else {
        refereeRef.current = new SquatReferee(handleCommand, totalReps, angle, userProfile)
      }

      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        )

        const modelAssetPath = isBench
        ? 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
        : 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'


        poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath,
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numPoses: 1
        })

        await startCamera(facingMode)
      } catch (err) {
        setCameraError('Failed to load: ' + err.message)
      }
    }

    setup()

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
      if (poseLandmarkerRef.current)  poseLandmarkerRef.current.close()
      if (barDetectorRef.current)     barDetectorRef.current.dispose()
      stopRecorder()
      setRecorderRef.current?.dispose()
      stopCurrentStream()
    }
    // Do not include facingMode here. Camera switching is handled manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleCommand, startCamera, totalReps, isBench, isDeadlift, angle, stopCurrentStream, stopRecorder])

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleBack = () => navigate('/')

  const handleSwitchCamera = async () => {
    const nextFacingMode = facingMode === 'user' ? 'environment' : 'user'
    await startCamera(nextFacingMode)
  }

  const handleToggleRecording = async () => {
    if (setRecorderRef.current?.isRecording()) {
      stopRecorder()
      return
    }

    await startRecorder()
  }

  const handleDismiss = () => {
    setResult(LiftResult.PENDING)
    setRepResults([])
    repResultsRef.current = []
    refereeRef.current?.reset()
    landmarkSmootherRef.current.reset()
    navigate('/')
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <button onClick={handleBack} style={styles.backButton}>
          ← Back
        </button>

        <span style={styles.liftInfo}>
          {formatParam(liftId)} | {formatParam(angle)} | {totalReps} {totalReps === 1 ? 'rep' : 'reps'}
        </span>

        {recordingUrl ? (
          <a
            href={recordingUrl}
            download={recordingFilename}
            style={styles.downloadButton}
          >
            Download
          </a>
        ) : (
          <button
            onClick={handleToggleRecording}
            style={{
              ...styles.recordButton,
              ...(recordingState === 'recording' ? styles.recordButtonActive : {}),
            }}
          >
            {recordingState === 'recording'
              ? '● Rec'
              : recordingState === 'finalizing'
                ? 'Saving...'
                : 'Record'}
          </button>
        )}

        <button onClick={handleSwitchCamera} style={styles.switchCameraButton}>
          {facingMode === 'user' ? 'Back Camera' : 'Front Camera'}
        </button>
      </div>

      {recordingError && (
        <div style={styles.recordingError}>
          {recordingError}
        </div>
      )}

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
    gap:        '8px',
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
    flex:       1,
    minWidth:   0,
  },
  switchCameraButton: {
    fontSize:     '12px',
    color:        '#fff',
    background:   '#222',
    border:       '1px solid #444',
    borderRadius: '8px',
    padding:      '8px 9px',
    cursor:       'pointer',
    whiteSpace:   'nowrap',
  },
  recordButton: {
    fontSize:     '12px',
    color:        '#fff',
    background:   '#222',
    border:       '1px solid #444',
    borderRadius: '8px',
    padding:      '8px 9px',
    cursor:       'pointer',
    whiteSpace:   'nowrap',
  },
  recordButtonActive: {
    background: '#5a1111',
    border:     '1px solid #cc3333',
    color:      '#fff',
  },
  downloadButton: {
    fontSize:       '12px',
    color:          '#000',
    background:     '#fff',
    border:         '1px solid #fff',
    borderRadius:   '8px',
    padding:        '8px 9px',
    cursor:         'pointer',
    whiteSpace:     'nowrap',
    textDecoration: 'none',
    fontWeight:     '700',
  },
  recordingError: {
    background: '#330000',
    color:      '#ffaaaa',
    fontSize:   '12px',
    padding:    '6px 12px',
    textAlign:  'center',
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
  },
}

export default CameraScreen