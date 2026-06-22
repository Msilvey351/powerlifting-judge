// src/logic/velocityTracker.js

// Tracks concentric velocity in normalised screen units per second.
//
// MediaPipe y-coordinates increase downward.
// Concentric movement for all three lifts is generally upward,
// so positive concentric velocity is:
//
// previousY - currentY
//
// Units:
//   norm/s = fraction of frame height per second
//
// Later this can be converted to m/s if we add a real-world scale calibration.

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

    // Keep memory bounded
    if (this.samples.length > 300) {
      this.samples.shift()
    }
  }

  getMetrics() {
    if (!this.started || this.samples.length < 2) {
      return null
    }

    const first = this.samples[0]
    const last  = this.samples[this.samples.length - 1]

    const durationSec = (last.t - first.t) / 1000
    if (durationSec <= 0) return null

    // Positive distance = upward movement
    const distanceNorm = first.y - last.y
    const avgVelocityNorm = distanceNorm / durationSec

    let peakVelocityNorm = 0

    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1]
      const curr = this.samples[i]

      const dt = (curr.t - prev.t) / 1000
      if (dt <= 0) continue

      const velocity = (prev.y - curr.y) / dt

      // Only count upward/concentric movement.
      if (velocity > peakVelocityNorm) {
        peakVelocityNorm = velocity
      }
    }

    return {
      unit: 'norm/s',
      distanceNorm,
      durationSec,
      avgVelocityNorm,
      peakVelocityNorm,
    }
  }
}