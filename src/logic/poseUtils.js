// src/logic/poseUtils.js

// ── Landmark indices ──────────────────────────────────────────────────────────
export const LANDMARK_INDICES = {
  left_shoulder:    11,
  right_shoulder:   12,
  left_elbow:       13,
  right_elbow:      14,
  left_wrist:       15,
  right_wrist:      16,

  left_hip:         23,
  right_hip:        24,
  left_knee:        25,
  right_knee:       26,
  left_ankle:       27,
  right_ankle:      28,

  left_heel:        29,
  right_heel:       30,
  left_foot_index:  31,
  right_foot_index: 32,
}

/**
 * Extract landmarks from raw MediaPipe results.
 */
export function extractLandmarks(rawLandmarks) {
  const result = {}

  for (const [name, idx] of Object.entries(LANDMARK_INDICES)) {
    const lm = rawLandmarks[idx]
    result[name] = {
      x:          lm.x,
      y:          lm.y,
      z:          lm.z,
      visibility: lm.visibility ?? 1.0,
    }
  }

  return result
}

/**
 * Angle at point b, given three points a, b, c.
 */
export function angleBetween(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y }
  const bc = { x: c.x - b.x, y: c.y - b.y }

  const dot    = ba.x * bc.x + ba.y * bc.y
  const normBa = Math.sqrt(ba.x ** 2 + ba.y ** 2)
  const normBc = Math.sqrt(bc.x ** 2 + bc.y ** 2)
  const cosA   = dot / (normBa * normBc + 1e-6)

  return (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI
}

/**
 * Compute knee and hip angles for the given side.
 */
export function computeAngles(landmarks, side) {
  const hip      = landmarks[`${side}_hip`]
  const knee     = landmarks[`${side}_knee`]
  const ankle    = landmarks[`${side}_ankle`]
  const shoulder = landmarks[`${side}_shoulder`]

  return {
    knee: angleBetween(hip,      knee, ankle),
    hip:  angleBetween(shoulder, hip,  knee),
  }
}

/**
 * How far apart are the hips horizontally?
 */
export function lateralityScore(landmarks) {
  return Math.abs(landmarks.left_hip.x - landmarks.right_hip.x)
}

/**
 * Classify camera angle based on hip separation.
 */
export function classifyCamera(score) {
  if (score < 0.08) return 'side-on'
  if (score < 0.20) return 'diagonal'
  return 'front-facing'
}

/**
 * Pick whichever side has better lower-body landmark visibility.
 */
export function pickBestSide(landmarks, minVisibility = 0.5) {
  const leftScore = Math.min(
    landmarks.left_hip?.visibility   ?? 0,
    landmarks.left_knee?.visibility  ?? 0,
    landmarks.left_ankle?.visibility ?? 0,
  )
  const rightScore = Math.min(
    landmarks.right_hip?.visibility   ?? 0,
    landmarks.right_knee?.visibility  ?? 0,
    landmarks.right_ankle?.visibility ?? 0,
  )

  const best      = leftScore >= rightScore ? 'left' : 'right'
  const bestScore = best === 'left' ? leftScore : rightScore

  return bestScore > minVisibility ? best : null
}

/**
 * Check whether the lifter has reached squat depth.
 * depthMargin adds a buffer so depth only triggers when hip is
 * clearly below the knee, not just at the threshold.
 * Fix 4: depth margin reduces false depth at threshold boundary.
 */
export function checkDepth(landmarks, side, camera, depthMargin = 0.01) {
  const hipY    = landmarks[`${side}_hip`].y
  const kneeY   = landmarks[`${side}_knee`].y
  const yMargin = hipY - kneeY

  if (camera === 'side-on') {
    return { atDepth: yMargin > depthMargin, margin: yMargin }
  }

  if (camera === 'front-facing') {
    const angles = computeAngles(landmarks, side)
    return { atDepth: angles.hip < 100, margin: (100 - angles.hip) / 100 }
  }

  const angles = computeAngles(landmarks, side)
  return {
    atDepth: angles.hip < 105 && yMargin > (depthMargin - 0.01),
    margin:  yMargin,
  }
}

/**
 * Calculate hand to foot distance for front view deadlift.
 */
export function handFootDistance(landmarks) {
  const leftDist  = Math.abs(landmarks.left_wrist.y  - landmarks.left_ankle.y)
  const rightDist = Math.abs(landmarks.right_wrist.y - landmarks.right_ankle.y)
  return (leftDist + rightDist) / 2
}

// ── Visibility helpers ────────────────────────────────────────────────────────

export function isVisible(lm, threshold = 0.5) {
  return !!lm && (lm.visibility ?? 1) >= threshold
}

export function areVisible(landmarks, keys, threshold = 0.5) {
  return keys.every(key => isVisible(landmarks[key], threshold))
}

export function visibleKeys(landmarks, keys, threshold = 0.5) {
  return keys.filter(key => isVisible(landmarks[key], threshold))
}

export function missingKeys(landmarks, keys, threshold = 0.5) {
  return keys.filter(key => !isVisible(landmarks[key], threshold))
}

// ── Bench press helpers ───────────────────────────────────────────────────────

export function euclideanDistance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

export function benchPickBestSide(landmarks, minVisibility = 0.5) {
  const leftScore = Math.min(
    landmarks.left_shoulder?.visibility ?? 0,
    landmarks.left_elbow?.visibility    ?? 0,
    landmarks.left_wrist?.visibility    ?? 0,
  )
  const rightScore = Math.min(
    landmarks.right_shoulder?.visibility ?? 0,
    landmarks.right_elbow?.visibility    ?? 0,
    landmarks.right_wrist?.visibility    ?? 0,
  )

  const best      = leftScore >= rightScore ? 'left' : 'right'
  const bestScore = best === 'left' ? leftScore : rightScore

  return bestScore > minVisibility ? best : null
}

export function computeElbowAngle(landmarks, side, minVisibility = 0.5) {
  const shoulder = landmarks[`${side}_shoulder`]
  const elbow    = landmarks[`${side}_elbow`]
  const wrist    = landmarks[`${side}_wrist`]

  if (
    !isVisible(shoulder, minVisibility) ||
    !isVisible(elbow, minVisibility) ||
    !isVisible(wrist, minVisibility)
  ) {
    return null
  }

  return angleBetween(shoulder, elbow, wrist)
}

export function getBenchSideLandmarkKeys(side) {
  return [
    `${side}_shoulder`,
    `${side}_elbow`,
    `${side}_wrist`,
    `${side}_hip`,
    `${side}_knee`,
    `${side}_ankle`,
    `${side}_heel`,
    `${side}_foot_index`,
  ]
}

// ── Fix 1: Landmark smoother ──────────────────────────────────────────────────
//
// Maintains a rolling average of each landmark's x, y, z, visibility
// over a short window of frames.
//
// This dramatically reduces jitter from MediaPipe noise, gym lighting,
// occlusion, and clothing without adding meaningful delay.
//
// Window of 5 frames ≈ 167ms at 30fps.
// Good balance of smoothness vs responsiveness.
// Tune between 3 (snappier) and 8 (smoother) depending on environment.

export class LandmarkSmoother {
  constructor(windowSize = 5) {
    this.windowSize = windowSize
    this.history = {}
  }

  smooth(landmarks) {
    const smoothed = {}

    for (const [name, lm] of Object.entries(landmarks)) {
      if (!this.history[name]) {
        this.history[name] = []
      }

      const hist = this.history[name]

      hist.push({
        x:          lm.x,
        y:          lm.y,
        z:          lm.z,
        visibility: lm.visibility ?? 1.0,
      })

      if (hist.length > this.windowSize) hist.shift()

      const n = hist.length

      smoothed[name] = {
        x:          hist.reduce((s, p) => s + p.x, 0) / n,
        y:          hist.reduce((s, p) => s + p.y, 0) / n,
        z:          hist.reduce((s, p) => s + p.z, 0) / n,
        visibility: hist.reduce((s, p) => s + p.visibility, 0) / n,
      }
    }

    return smoothed
  }

  reset() {
    this.history = {}
  }
}

// ── Fix 2: Hysteresis helper ──────────────────────────────────────────────────
//
// Prevents binary state from flickering when a value jitters
// at a threshold boundary.
//
// Example: knee angle jittering between 163° and 167° around a 165° threshold.
// Without hysteresis: kneeLocked flips every frame.
// With hysteresis (enter=165, exit=155): once locked, stays locked
// until angle clearly drops below 155°.

export function updateHysteresis(currentState, value, enterThreshold, exitThreshold) {
  if (!currentState && value >= enterThreshold) return true
  if (currentState && value < exitThreshold) return false
  return currentState
}