// src/logic/downwardMovement.js

/**
 * MediaPipe y-coordinates increase downward.
 *
 * During the concentric phase, the wrist/bar proxy should generally move upward,
 * meaning y should decrease.
 *
 * A downward movement fault occurs when y increases by more than threshold
 * from the best/highest point reached so far.
 */

export function getWristProxyY(landmarks, minVisibility = 0.5) {
  const left  = landmarks.left_wrist
  const right = landmarks.right_wrist

  const leftVisible =
    left &&
    left.visibility != null &&
    left.visibility >= minVisibility

  const rightVisible =
    right &&
    right.visibility != null &&
    right.visibility >= minVisibility

  // Both visible — use midpoint
  if (leftVisible && rightVisible) {
    return (left.y + right.y) / 2
  }

  // One visible — use whichever is visible
  if (leftVisible) return left.y
  if (rightVisible) return right.y

  // No wrists visible — no judgement
  return null
}

export class DownwardMovementDetector {
  constructor(threshold = 0.02, requiredFrames = 3) {
    this.threshold = threshold
    this.requiredFrames = requiredFrames
    this.reset()
  }

  reset() {
    this.active = false
    this.bestY = null
    this.badFrames = 0
    this.faulted = false
  }

  start(y) {
    if (y == null || Number.isNaN(y)) return

    this.active = true
    this.bestY = y
    this.badFrames = 0
    this.faulted = false
  }

  update(y) {
    if (
      !this.active ||
      this.faulted ||
      y == null ||
      Number.isNaN(y)
    ) {
      return false
    }

    // Upward movement: y gets smaller. Update best/highest point.
    if (y < this.bestY) {
      this.bestY = y
      this.badFrames = 0
      return false
    }

    // Downward movement: y gets larger.
    if (y > this.bestY + this.threshold) {
      this.badFrames++
    } else {
      this.badFrames = Math.max(0, this.badFrames - 1)
    }

    if (this.badFrames >= this.requiredFrames) {
      this.faulted = true
      return true
    }

    return false
  }
}