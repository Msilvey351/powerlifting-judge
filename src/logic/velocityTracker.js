// src/logic/velocityTracker.js

export class ConcentricVelocityTracker {
  constructor() {
    this.reset()
  }

  reset() {
    this.samples = []
    this.started = false
  }

  start(y) {
    if (y == null || Number.isNaN(y)) return

    const t = performance.now()
    this.samples = [{ t, y }]
    this.started = true
  }

  add(y) {
    if (!this.started || y == null || Number.isNaN(y)) return

    const t = performance.now()
    const last = this.samples[this.samples.length - 1]

    if (!last || t <= last.t) return

    this.samples.push({ t, y })

    if (this.samples.length > 300) {
      this.samples.shift()
    }
  }

  /**
   * scale is optional:
   * {
   *   metresPerNormUnit,
   *   source,
   *   segment,
   *   confidence
   * }
   */
  getMetrics(scale = null) {
    if (!this.started || this.samples.length < 2) {
      return null
    }

    const first = this.samples[0]
    const last  = this.samples[this.samples.length - 1]

    const durationSec = (last.t - first.t) / 1000
    if (durationSec <= 0) return null

    const distanceNorm = first.y - last.y
    const avgVelocityNorm = distanceNorm / durationSec

    let peakVelocityNorm = 0

    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1]
      const curr = this.samples[i]

      const dt = (curr.t - prev.t) / 1000
      if (dt <= 0) continue

      const velocity = (prev.y - curr.y) / dt

      if (velocity > peakVelocityNorm) {
        peakVelocityNorm = velocity
      }
    }

    const metrics = {
      unit: 'norm/s',
      distanceNorm,
      durationSec,
      avgVelocityNorm,
      peakVelocityNorm,
    }

    if (scale?.metresPerNormUnit) {
      metrics.unit = 'm/s'
      metrics.estimated = true
      metrics.scaleSource = scale.source ?? 'height-estimate'
      metrics.scaleSegment = scale.segment ?? null
      metrics.scaleConfidence = scale.confidence ?? 'estimated'
      metrics.metresPerNormUnit = scale.metresPerNormUnit

      metrics.distanceM = distanceNorm * scale.metresPerNormUnit
      metrics.avgVelocityMS = avgVelocityNorm * scale.metresPerNormUnit
      metrics.peakVelocityMS = peakVelocityNorm * scale.metresPerNormUnit
    }

    return metrics
  }
}