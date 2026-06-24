// src/logic/setRecorder.js
import { DrawingUtils } from '@mediapipe/tasks-vision'
import { drawRelevantVisiblePose } from './drawingPolicy'

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=opus',
    'video/webm',
    'video/mp4',
  ]

  if (typeof MediaRecorder === 'undefined') return ''

  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type
    }
  }

  return ''
}

function formatDateForFilename() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')

  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  ].join('-')
}

function formatVelocityForSummary(velocity) {
  if (!velocity) return null

  if (
    velocity.avgVelocityMS != null &&
    velocity.peakVelocityMS != null &&
    !Number.isNaN(velocity.avgVelocityMS) &&
    !Number.isNaN(velocity.peakVelocityMS)
  ) {
    return {
      avg:  velocity.avgVelocityMS.toFixed(2),
      peak: velocity.peakVelocityMS.toFixed(2),
      unit: 'm/s est.',
    }
  }

  if (
    velocity.avgVelocityNorm != null &&
    velocity.peakVelocityNorm != null &&
    !Number.isNaN(velocity.avgVelocityNorm) &&
    !Number.isNaN(velocity.peakVelocityNorm)
  ) {
    return {
      avg:  velocity.avgVelocityNorm.toFixed(3),
      peak: velocity.peakVelocityNorm.toFixed(3),
      unit: velocity.unit ?? 'norm/s',
    }
  }

  return null
}

export class SetRecorder {
  constructor({
    fps = 30,
    onStop = null,
    onError = null,
  } = {}) {
    this.fps = fps
    this.onStop = onStop
    this.onError = onError

    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d')
    this.drawingUtils = new DrawingUtils(this.ctx)

    this.mediaRecorder = null
    this.chunks = []
    this.canvasStream = null
    this.micStream = null
    this.combinedStream = null
    this.mimeType = ''
    this.recording = false
    this.filename = `set-recording-${formatDateForFilename()}.webm`
  }

  isSupported() {
    return (
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof this.canvas.captureStream === 'function' &&
      typeof MediaRecorder !== 'undefined'
    )
  }

  isRecording() {
    return this.recording
  }

  async start({ width, height, includeAudio = true, filename = null } = {}) {
    if (!this.isSupported()) {
      throw new Error('Recording is not supported in this browser')
    }

    if (this.recording) return

    this.canvas.width = width || 1280
    this.canvas.height = height || 720

    if (filename) this.filename = filename

    this.mimeType = pickMimeType()
    this.chunks = []

    this.canvasStream = this.canvas.captureStream(this.fps)

    const tracks = [
      ...this.canvasStream.getVideoTracks(),
    ]

    // Optional mic / room audio.
    // If denied or unavailable, recording continues as video-only.
    if (includeAudio) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        })

        tracks.push(...this.micStream.getAudioTracks())
      } catch (err) {
        console.warn('[SetRecorder] Mic unavailable, recording video only:', err.message)
      }
    }

    this.combinedStream = new MediaStream(tracks)

    const options = this.mimeType ? { mimeType: this.mimeType } : undefined

    this.mediaRecorder = new MediaRecorder(this.combinedStream, options)

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data)
      }
    }

    this.mediaRecorder.onerror = (event) => {
      console.warn('[SetRecorder] recorder error:', event)
      if (this.onError) this.onError(event)
    }

    this.mediaRecorder.onstop = () => {
      const type = this.mimeType || 'video/webm'
      const blob = new Blob(this.chunks, { type })
      const url = URL.createObjectURL(blob)

      this.recording = false
      this._stopStreams()

      if (this.onStop) {
        this.onStop({
          blob,
          url,
          filename: this.filename,
          mimeType: type,
        })
      }
    }

    this.mediaRecorder.start(250)
    this.recording = true
  }

  stop() {
    if (!this.mediaRecorder || !this.recording) return

    try {
      this.mediaRecorder.stop()
    } catch (err) {
      console.warn('[SetRecorder] stop failed:', err)
      this.recording = false
      this._stopStreams()
    }
  }

  dispose() {
    if (this.recording) {
      this.stop()
    } else {
      this._stopStreams()
    }
  }

  _stopStreams() {
    if (this.canvasStream) {
      this.canvasStream.getTracks().forEach(t => t.stop())
      this.canvasStream = null
    }

    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop())
      this.micStream = null
    }

    if (this.combinedStream) {
      this.combinedStream.getTracks().forEach(t => t.stop())
      this.combinedStream = null
    }
  }

  drawFrame({
    video,
    rawLandmarks,
    liftId,
    angle,
    update,
    statusText,
  }) {
    if (!this.recording || !video) return

    const ctx = this.ctx
    const width = this.canvas.width
    const height = this.canvas.height

    this._drawVideoCover(video, width, height)

    if (rawLandmarks) {
      drawRelevantVisiblePose({
        drawingUtils: this.drawingUtils,
        rawLandmarks,
        liftId,
        angle,
        update,
        landmarkStyle:  { color: '#FF3333', lineWidth: 1, radius: 4 },
        connectorStyle: { color: '#00FF66', lineWidth: 3 },
        visibilityThreshold: 0.5,
      })
    }

    this._drawBottomPrompt(statusText)
  }

  drawSummary({
    video,
    rawLandmarks,
    liftId,
    angle,
    update,
    statusText,
    repResults,
    totalReps,
  }) {
    if (!this.recording) return

    this.drawFrame({
      video,
      rawLandmarks,
      liftId,
      angle,
      update,
      statusText,
    })

    this._drawSummaryOverlay(repResults, totalReps)
  }

  _drawVideoCover(video, canvasW, canvasH) {
    const ctx = this.ctx

    const videoW = video.videoWidth || canvasW
    const videoH = video.videoHeight || canvasH

    const videoRatio = videoW / videoH
    const canvasRatio = canvasW / canvasH

    let drawW, drawH, drawX, drawY

    if (videoRatio > canvasRatio) {
      drawH = canvasH
      drawW = drawH * videoRatio
      drawX = (canvasW - drawW) / 2
      drawY = 0
    } else {
      drawW = canvasW
      drawH = drawW / videoRatio
      drawX = 0
      drawY = (canvasH - drawH) / 2
    }

    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvasW, canvasH)
    ctx.drawImage(video, drawX, drawY, drawW, drawH)
  }

  _drawBottomPrompt(statusText) {
    const ctx = this.ctx
    const width = this.canvas.width
    const height = this.canvas.height

    const barH = Math.max(72, height * 0.1)
    const y = height - barH

    ctx.save()

    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)'
    ctx.fillRect(0, y, width, barH)

    ctx.fillStyle = '#fff'
    ctx.font = `${Math.max(20, Math.round(height * 0.032))}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    ctx.fillText(statusText || '', width / 2, y + barH / 2)

    ctx.restore()
  }

  _drawSummaryOverlay(repResults = [], totalReps = 0) {
    const ctx = this.ctx
    const width = this.canvas.width
    const height = this.canvas.height

    const cardW = Math.min(width * 0.86, 760)
    const cardH = Math.min(height * 0.72, 620)
    const x = (width - cardW) / 2
    const y = (height - cardH) / 2

    const goodReps = repResults.filter(r => r.result === 'WHITE').length

    ctx.save()

    // dark overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.70)'
    ctx.fillRect(0, 0, width, height)

    // card
    this._roundRect(ctx, x, y, cardW, cardH, 24)
    ctx.fillStyle = 'rgba(20, 20, 20, 0.96)'
    ctx.fill()
    ctx.strokeStyle = '#444'
    ctx.lineWidth = 2
    ctx.stroke()

    // title
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = `700 ${Math.round(cardH * 0.07)}px system-ui, sans-serif`
    ctx.fillText('SET COMPLETE', x + cardW / 2, y + 28)

    ctx.font = `500 ${Math.round(cardH * 0.04)}px system-ui, sans-serif`
    ctx.fillStyle = '#bbb'
    ctx.fillText(
      `${goodReps} / ${totalReps} good ${totalReps === 1 ? 'lift' : 'lifts'}`,
      x + cardW / 2,
      y + 78
    )

    // rep rows
    const rowStartY = y + 130
    const rowH = 54
    const maxRows = Math.floor((cardH - 180) / rowH)
    const rows = repResults.slice(0, maxRows)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    rows.forEach((rep, i) => {
      const rowY = rowStartY + i * rowH

      ctx.fillStyle = 'rgba(255,255,255,0.045)'
      this._roundRect(ctx, x + 28, rowY, cardW - 56, rowH - 8, 10)
      ctx.fill()

      ctx.fillStyle = '#fff'
      ctx.font = `600 ${Math.round(cardH * 0.035)}px system-ui, sans-serif`
      ctx.fillText(`Rep ${rep.rep}`, x + 48, rowY + 20)

      const velocity = formatVelocityForSummary(rep.velocity)

      if (velocity) {
        ctx.fillStyle = '#aaa'
        ctx.font = `400 ${Math.round(cardH * 0.026)}px system-ui, sans-serif`
        ctx.fillText(
          `Avg ${velocity.avg} ${velocity.unit}  |  Peak ${velocity.peak} ${velocity.unit}`,
          x + 48,
          rowY + 42
        )
      } else if (rep.faults && rep.faults.length > 0) {
        ctx.fillStyle = '#ff7777'
        ctx.font = `400 ${Math.round(cardH * 0.026)}px system-ui, sans-serif`
        ctx.fillText(rep.faults.join(', '), x + 48, rowY + 42)
      }

      // light
      const lightX = x + cardW - 62
      const lightY = rowY + 24
      ctx.beginPath()
      ctx.arc(lightX, lightY, 12, 0, Math.PI * 2)
      ctx.fillStyle = rep.result === 'WHITE' ? '#fff' : '#cc0000'
      ctx.fill()
    })

    if (repResults.length > maxRows) {
      ctx.textAlign = 'center'
      ctx.fillStyle = '#888'
      ctx.font = `400 ${Math.round(cardH * 0.026)}px system-ui, sans-serif`
      ctx.fillText(
        `+ ${repResults.length - maxRows} more reps`,
        x + cardW / 2,
        y + cardH - 36
      )
    }

    ctx.restore()
  }

  _roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2)

    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + w - radius, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
    ctx.lineTo(x + w, y + h - radius)
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
    ctx.lineTo(x + radius, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
    ctx.lineTo(x, y + radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.closePath()
  }
}