// src/logic/barDetector.js
const DETECT_INTERVAL  = 25
const MAX_LOST_FRAMES  = 45
const MIN_LINE_LENGTH  = 0.35
const ROI_MARGIN       = 0.12
const LK_WIN_SIZE      = 21
const LK_MAX_LEVEL     = 3
const MIN_TRACK_POINTS = 4

export class BarDetector {
  constructor() {
    this._frameCount  = 0
    this._barY        = null
    this._tracking    = false
    this._lostFrames  = 0
    this._prevGray    = null
    this._trackPoints = null
    this._frameWidth  = 1
    this._frameHeight = 1
  }

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

  forceRedetect() {
    this._tracking   = false
    this._lostFrames = MAX_LOST_FRAMES + 1
  }

  getBarY() {
    return this._barY
  }

  dispose() {
    this._releasePrev()
    if (this._trackPoints) { this._trackPoints.delete(); this._trackPoints = null }
  }

  _detect(videoEl, wristY) {
    const cv = window.cv
    let src, gray, roiGray, blurred, edges, lines

    try {
      src     = this._videoToMat(videoEl)
      gray    = new cv.Mat()
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

      const roi = this._computeROI(wristY, gray.cols, gray.rows)
      roiGray   = gray.roi(roi)

      blurred = new cv.Mat()
      cv.GaussianBlur(roiGray, blurred, new cv.Size(5, 5), 0)
      edges = new cv.Mat()
      cv.Canny(blurred, edges, 50, 150)

      lines = new cv.Mat()
      const minLen = Math.round(MIN_LINE_LENGTH * roi.width)
      const maxGap = Math.round(0.05 * roi.width)
      cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 30, minLen, maxGap)

      const barLine = this._pickBarLine(lines, roi)

      if (barLine) {
        const absY       = roi.y + barLine.y
        this._barY       = absY / gray.rows
        this._initTracking(gray, roi, barLine)
        this._tracking   = true
        this._lostFrames = 0
      } else {
        this._lostFrames++
        if (this._lostFrames > MAX_LOST_FRAMES) {
          this._barY     = null
          this._tracking = false
        }
      }

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

  _track(videoEl) {
    const cv = window.cv
    if (!this._prevGray || !this._trackPoints || this._trackPoints.rows === 0) {
      this._lostFrames++
      return
    }

    let currGray, nextPoints, status, err

    try {
      currGray = this._videoToMat(videoEl)
      const tmp = new cv.Mat()
      cv.cvtColor(currGray, tmp, cv.COLOR_RGBA2GRAY)
      currGray.delete()
      currGray = tmp

      nextPoints = new cv.Mat()
      status     = new cv.Mat()
      err        = new cv.Mat()

      cv.calcOpticalFlowPyrLK(
        this._prevGray, currGray,
        this._trackPoints, nextPoints,
        status, err,
        new cv.Size(LK_WIN_SIZE, LK_WIN_SIZE),
        LK_MAX_LEVEL
      )

      const goodY = []
      for (let i = 0; i < status.rows; i++) {
        if (status.data[i] === 1) {
          goodY.push(nextPoints.data32F[i * 2 + 1])
        }
      }

      if (goodY.length >= MIN_TRACK_POINTS) {
        goodY.sort((a, b) => a - b)
        this._barY       = goodY[Math.floor(goodY.length / 2)] / this._frameHeight
        this._lostFrames = 0
        this._trackPoints.delete()
        this._trackPoints = this._buildPointMat(
          goodY.map((y, i) => ({ x: nextPoints.data32F[i * 2], y }))
        )
      } else {
        this._lostFrames++
      }

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
    canvas.getContext('2d').drawImage(videoEl, 0, 0)
    return cv.matFromImageData(
      canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    )
  }

  _computeROI(wristY, frameWidth, frameHeight) {
    const cv      = window.cv
    const wristPx = (wristY ?? 0.5) * frameHeight
    const margin  = ROI_MARGIN * frameHeight
    const roiTop  = Math.max(0, Math.round(wristPx - margin))
    const roiBot  = Math.min(frameHeight, Math.round(wristPx + margin))
    return new cv.Rect(0, roiTop, frameWidth, Math.max(roiBot - roiTop, 10))
  }

  _pickBarLine(lines, roi) {
    if (lines.rows === 0) return null
    let best = null, bestLen = 0
    for (let i = 0; i < lines.rows; i++) {
      const x1    = lines.data32S[i * 4]
      const y1    = lines.data32S[i * 4 + 1]
      const x2    = lines.data32S[i * 4 + 2]
      const y2    = lines.data32S[i * 4 + 3]
      const angle = Math.abs(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI)
      if (angle > 12 && angle < 168) continue
      const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
      if (len > bestLen) { bestLen = len; best = { x1, y1, x2, y2, y: Math.round((y1 + y2) / 2) } }
    }
    return best
  }

  _initTracking(fullGray, roi, barLine) {
    const points = []
    for (let i = 0; i < 10; i++) {
      const t = i / 9
      points.push({
        x: barLine.x1 + t * (barLine.x2 - barLine.x1),
        y: roi.y + barLine.y,
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
    if (this._prevGray) { this._prevGray.delete(); this._prevGray = null }
  }
}