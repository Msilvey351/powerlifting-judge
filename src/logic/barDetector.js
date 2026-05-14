// src/logic/barDetector.js
//
// Hough line detection + Lucas-Kanade optical flow tracking for the barbell.
//
// Architecture:
//   detect()  — expensive, run every DETECT_INTERVAL frames
//   track()   — cheap, run every frame between detections
//   getBarY() — returns current best estimate of bar Y (normalised 0-1)
//
// Both detect() and track() accept a raw HTMLVideoElement.
// They internally manage OpenCV Mat objects and clean up after themselves.
//
// OpenCV.js is loaded globally in index.html as window.cv.
// All methods guard against cv not being ready yet.

const DETECT_INTERVAL   = 25   // re-run Hough every N frames
const MAX_LOST_FRAMES   = 45   // if tracking fails for this long, reset
const MIN_LINE_LENGTH   = 0.35 // minimum bar line as fraction of ROI width
const ROI_MARGIN        = 0.12 // how far above/below wrist Y to crop ROI (normalised)
const LK_WIN_SIZE       = 21   // Lucas-Kanade window size
const LK_MAX_LEVEL      = 3    // pyramid levels
const MIN_TRACK_POINTS  = 4    // minimum tracked points before re-detecting

export class BarDetector {
  constructor() {
    this._frameCount   = 0
    this._barY         = null   // normalised 0-1, null = not found
    this._tracking     = false
    this._lostFrames   = 0
    this._prevGray     = null   // cv.Mat — previous frame grayscale
    this._trackPoints  = null   // cv.Mat — points being tracked (float32, Nx1x2)
    this._frameWidth   = 1
    this._frameHeight  = 1
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Call every frame from the detection loop.
   * Pass the video element and the current wrist Y (normalised 0-1).
   * Returns normalised bar Y, or null if not found.
   */
  processFrame(videoEl, wristY) {
    if (!this._cvReady()) return this._barY

    this._frameCount++
    this._frameWidth  = videoEl.videoWidth
    this._frameHeight = videoEl.videoHeight

    const shouldDetect =
      !this._tracking ||
      this._lostFrames > MAX_LOST_FRAMES ||
      this._frameCount % DETECT_INTERVAL === 0

    if (shouldDetect) {
      this._detect(videoEl, wristY)
    } else {
      this._track(videoEl)
    }

    return this._barY
  }

  /**
   * Force a fresh detection on the next frame.
   * Call this when the lift state changes significantly (e.g. LOCKOUT → DESCENDING).
   */
  forceRedetect() {
    this._tracking   = false
    this._lostFrames = MAX_LOST_FRAMES + 1
  }

  /**
   * Get the last known bar Y (normalised), or null.
   */
  getBarY() {
    return this._barY
  }

  /**
   * Clean up OpenCV Mats. Call when CameraScreen unmounts.
   */
  dispose() {
    this._releasePrev()
    if (this._trackPoints) { this._trackPoints.delete(); this._trackPoints = null }
  }

  // ── Detection (Hough) ──────────────────────────────────────────────────────

  _detect(videoEl, wristY) {
    const cv = window.cv
    let src, gray, roiGray, blurred, edges, lines

    try {
      // 1. Grab current frame into a Mat
      src  = this._videoToMat(videoEl)
      gray = new cv.Mat()
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

      // 2. Crop ROI around the wrist
      const roi    = this._computeROI(wristY, gray.cols, gray.rows)
      roiGray      = gray.roi(roi)

      // 3. Blur + edge detect
      blurred = new cv.Mat()
      cv.GaussianBlur(roiGray, blurred, new cv.Size(5, 5), 0)
      edges = new cv.Mat()
      cv.Canny(blurred, edges, 50, 150)

      // 4. Probabilistic Hough — find line segments
      lines = new cv.Mat()
      const minLen    = Math.round(MIN_LINE_LENGTH * roi.width)
      const maxGap    = Math.round(0.05 * roi.width)
      cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 30, minLen, maxGap)

      // 5. Filter for horizontal lines, pick the longest
      const barLine = this._pickBarLine(lines, roi)

      if (barLine) {
        // barLine.y is in ROI coords — convert back to full frame
        const absY    = roi.y + barLine.y
        this._barY    = absY / gray.rows     // normalise to 0-1

        // 6. Sample points along the line for tracking
        this._initTracking(gray, roi, barLine)
        this._tracking   = true
        this._lostFrames = 0

        console.log(`[BarDetector] Detected bar at Y=${this._barY.toFixed(3)}`)
      } else {
        this._lostFrames++
        if (this._lostFrames > MAX_LOST_FRAMES) {
          this._barY    = null
          this._tracking = false
        }
        console.log(`[BarDetector] No bar found (lost=${this._lostFrames})`)
      }

      // Save grayscale for next LK frame
      this._releasePrev()
      this._prevGray = gray.clone()

    } catch (err) {
      console.warn('[BarDetector] detect error:', err)
    } finally {
      src?.delete()
      gray?.delete()
      roiGray?.delete()
      blurred?.delete()
      edges?.delete()
      lines?.delete()
    }
  }

  // ── Tracking (Lucas-Kanade) ────────────────────────────────────────────────

  _track(videoEl) {
    const cv = window.cv
    if (!this._prevGray || !this._trackPoints || this._trackPoints.rows === 0) {
      this._lostFrames++
      return
    }

    let currGray, nextPoints, status, err

    try {
      currGray   = this._videoToMat(videoEl)
      const tmp  = new cv.Mat()
      cv.cvtColor(currGray, tmp, cv.COLOR_RGBA2GRAY)
      currGray.delete()
      currGray = tmp

      nextPoints = new cv.Mat()
      status     = new cv.Mat()
      err        = new cv.Mat()

      cv.calcOpticalFlowPyrLK(
        this._prevGray,
        currGray,
        this._trackPoints,
        nextPoints,
        status,
        err,
        new cv.Size(LK_WIN_SIZE, LK_WIN_SIZE),
        LK_MAX_LEVEL
      )

      // Collect successfully tracked points
      const goodY = []
      for (let i = 0; i < status.rows; i++) {
        if (status.data[i] === 1) {
          // nextPoints is Nx1x2 float32
          const y = nextPoints.data32F[i * 2 + 1]
          goodY.push(y)
        }
      }

      if (goodY.length >= MIN_TRACK_POINTS) {
        // Use median Y — robust against outlier points drifting off the bar
        goodY.sort((a, b) => a - b)
        const medianY = goodY[Math.floor(goodY.length / 2)]
        this._barY    = medianY / this._frameHeight
        this._lostFrames = 0

        // Update track points to the good ones only
        this._trackPoints.delete()
        this._trackPoints = this._buildPointMat(
          goodY.map((y, i) => ({
            x: nextPoints.data32F[i * 2],
            y
          }))
        )
      } else {
        this._lostFrames++
        console.log(`[BarDetector] LK: only ${goodY.length} good points, lost=${this._lostFrames}`)
      }

      // Roll prev frame
      this._releasePrev()
      this._prevGray = currGray.clone()

    } catch (err2) {
      console.warn('[BarDetector] track error:', err2)
      this._lostFrames++
    } finally {
      currGray?.delete()
      nextPoints?.delete()
      status?.delete()
      err?.delete()
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _cvReady() {
    return typeof window !== 'undefined' &&
           window.cv &&
           window.cv.Mat !== undefined
  }

  _videoToMat(videoEl) {
    const cv     = window.cv
    const canvas = document.createElement('canvas')
    canvas.width  = videoEl.videoWidth
    canvas.height = videoEl.videoHeight
    const ctx    = canvas.getContext('2d')
    ctx.drawImage(videoEl, 0, 0)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return cv.matFromImageData(imageData)
  }

  _computeROI(wristY, frameWidth, frameHeight) {
    const cv     = window.cv
    // wristY is normalised — convert to pixels
    const wristPx  = (wristY ?? 0.5) * frameHeight
    const margin   = ROI_MARGIN * frameHeight
    const roiTop   = Math.max(0, Math.round(wristPx - margin))
    const roiBot   = Math.min(frameHeight, Math.round(wristPx + margin))
    const roiH     = roiBot - roiTop

    return new cv.Rect(0, roiTop, frameWidth, Math.max(roiH, 10))
  }

  _pickBarLine(lines, roi) {
    if (lines.rows === 0) return null

    let best     = null
    let bestLen  = 0
    const maxAngle = 12  // degrees from horizontal

    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i * 4]
      const y1 = lines.data32S[i * 4 + 1]
      const x2 = lines.data32S[i * 4 + 2]
      const y2 = lines.data32S[i * 4 + 3]

      const angle = Math.abs(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI)
      if (angle > maxAngle && angle < 180 - maxAngle) continue

      const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
      if (len > bestLen) {
        bestLen = len
        best    = {
          x1, y1, x2, y2,
          y: Math.round((y1 + y2) / 2)  // midpoint Y in ROI coords
        }
      }
    }

    return best
  }

  _initTracking(fullGray, roi, barLine) {
    const cv = window.cv

    // Sample 10 evenly spaced points along the detected line (in full frame coords)
    const count  = 10
    const points = []
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1)
      points.push({
        x: barLine.x1 + t * (barLine.x2 - barLine.x1),
        y: roi.y + barLine.y,   // convert to full frame Y
      })
    }

    if (this._trackPoints) this._trackPoints.delete()
    this._trackPoints = this._buildPointMat(points)
  }

  _buildPointMat(points) {
    const cv  = window.cv
    const mat = new cv.Mat(points.length, 1, cv.CV_32FC2)
    for (let i = 0; i < points.length; i++) {
      mat.data32F[i * 2]     = points[i].x
      mat.data32F[i * 2 + 1] = points[i].y
    }
    return mat
  }

  _releasePrev() {
    if (this._prevGray) {
      this._prevGray.delete()
      this._prevGray = null
    }
  }
}