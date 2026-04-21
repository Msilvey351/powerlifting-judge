// ── Landmark indices ──────────────────────────────────────────────────────────
// These match MediaPipe's 33-point pose model - same in Python and JS
export const LANDMARK_INDICES = {
  left_shoulder:  11,
  right_shoulder: 12,
  left_elbow:     13,
  right_elbow:    14,
  left_wrist:     15,
  right_wrist:    16,
  left_hip:       23,
  right_hip:      24,
  left_knee:      25,
  right_knee:     26,
  left_ankle:     27,
  right_ankle:    28,
}

/**
 * Extract the landmarks we care about from the raw MediaPipe results.
 * Returns an object like:
 * { left_hip: {x, y, z, visibility}, left_knee: {...}, ... }
 */
export function extractLandmarks(rawLandmarks) {
  const result = {}
  for (const [name, idx] of Object.entries(LANDMARK_INDICES)) {
    const lm = rawLandmarks[idx]
    result[name] = {
      x:          lm.x,
      y:          lm.y,
      z:          lm.z,
      visibility: lm.visibility ?? 1.0
    }
  }
  return result
}

/**
 * Angle at point b, given three points a, b, c.
 * Direct port of angle_between() from Python prototype.
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
 * Direct port of compute_angles() from Python prototype.
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
 * Low score = side-on, high score = front-facing.
 * Direct port of laterality_score() from Python prototype.
 */
export function lateralityScore(landmarks) {
  return Math.abs(landmarks.left_hip.x - landmarks.right_hip.x)
}

/**
 * Classify camera angle based on hip separation.
 * Direct port of classify_camera() from Python prototype.
 */
export function classifyCamera(score) {
  if (score < 0.08) return 'side-on'
  if (score < 0.20) return 'diagonal'
  return 'front-facing'
}

/**
 * Pick whichever side (left/right) has better landmark visibility.
 * Direct port of pick_best_side() from Python prototype.
 */
export function pickBestSide(landmarks, minVisibility = 0.5) {
  const leftScore = Math.min(
    landmarks.left_hip.visibility,
    landmarks.left_knee.visibility,
    landmarks.left_ankle.visibility
  )
  const rightScore = Math.min(
    landmarks.right_hip.visibility,
    landmarks.right_knee.visibility,
    landmarks.right_ankle.visibility
  )

  const best      = leftScore >= rightScore ? 'left' : 'right'
  const bestScore = best === 'left' ? leftScore : rightScore

  return bestScore > minVisibility ? best : null
}

/**
 * Check whether the lifter has reached squat depth.
 * Hip crease must be below the top of the knee.
 * Direct port of check_depth() from Python prototype.
 * Note: in normalised coordinates Y increases downward,
 * so hip.y > knee.y means hip is lower than knee.
 */
export function checkDepth(landmarks, side, camera) {
  const hipY    = landmarks[`${side}_hip`].y
  const kneeY   = landmarks[`${side}_knee`].y
  const yMargin = hipY - kneeY

  if (camera === 'side-on') {
    return { atDepth: yMargin > 0, margin: yMargin }
  }

  if (camera === 'front-facing') {
    const angles = computeAngles(landmarks, side)
    return { atDepth: angles.hip < 100, margin: (100 - angles.hip) / 100 }
  }

  // diagonal
  const angles = computeAngles(landmarks, side)
  return {
    atDepth: angles.hip < 105 && yMargin > -0.01,
    margin:  yMargin
  }
}

/**
 * Calculate hand to foot distance for front view deadlift detection.
 * Uses average of both sides for robustness.
 * Returns normalised distance (0-1).
 */
export function handFootDistance(landmarks) {
  const leftDist  = Math.abs(landmarks.left_wrist.y  - landmarks.left_ankle.y)
  const rightDist = Math.abs(landmarks.right_wrist.y - landmarks.right_ankle.y)
  return (leftDist + rightDist) / 2
}
