// src/logic/velocityScale.js
import { euclideanDistance } from './poseUtils.js'

// Anthropometric approximations as fraction of height.
// These are estimates, not lab-grade measurements.
const BODY_RATIOS = {
  thigh:    0.245, // hip → knee
  shin:     0.246, // knee → ankle
  upperArm: 0.186, // shoulder → elbow
  forearm:  0.146, // elbow → wrist
}

function validDistance(d) {
  return d != null && !Number.isNaN(d) && d > 0.001
}

function sideArmNorm(landmarks, side) {
  const shoulder = landmarks[`${side}_shoulder`]
  const elbow    = landmarks[`${side}_elbow`]
  const wrist    = landmarks[`${side}_wrist`]

  if (!shoulder || !elbow || !wrist) return null

  return euclideanDistance(shoulder, elbow) + euclideanDistance(elbow, wrist)
}

function sideThighNorm(landmarks, side) {
  const hip  = landmarks[`${side}_hip`]
  const knee = landmarks[`${side}_knee`]

  if (!hip || !knee) return null

  return euclideanDistance(hip, knee)
}

function sideShinNorm(landmarks, side) {
  const knee  = landmarks[`${side}_knee`]
  const ankle = landmarks[`${side}_ankle`]

  if (!knee || !ankle) return null

  return euclideanDistance(knee, ankle)
}

/**
 * Estimate metres per normalised screen unit.
 *
 * Returns:
 * {
 *   metresPerNormUnit,
 *   source: 'height-estimate',
 *   segment: 'arm' | 'thigh' | 'shin',
 *   confidence: 'estimated'
 * }
 *
 * Or null if height/profile/landmarks are unavailable.
 */
export function estimateMetresPerNormUnit(liftId, angle, landmarks, side, userProfile) {
  if (!userProfile?.heightM) return null

  const heightM = userProfile.heightM
  const view    = angle?.toLowerCase?.() ?? 'side'

  // ── Bench ────────────────────────────────────────────────────────────────
  // Use full arm segment length: shoulder→elbow + elbow→wrist.
  // This is better than shoulder→wrist because shoulder→wrist changes with elbow angle.
  if (liftId === 'bench') {
    const realArmM = heightM * (BODY_RATIOS.upperArm + BODY_RATIOS.forearm)

    if (view === 'front') {
      const leftNorm  = sideArmNorm(landmarks, 'left')
      const rightNorm = sideArmNorm(landmarks, 'right')
      const values    = [leftNorm, rightNorm].filter(validDistance)

      if (values.length === 0) return null

      const avgNorm = values.reduce((a, b) => a + b, 0) / values.length

      return {
        metresPerNormUnit: realArmM / avgNorm,
        source: 'height-estimate',
        segment: 'arm',
        confidence: 'estimated',
      }
    }

    const armNorm = sideArmNorm(landmarks, side)
    if (!validDistance(armNorm)) return null

    return {
      metresPerNormUnit: realArmM / armNorm,
      source: 'height-estimate',
      segment: 'arm',
      confidence: 'estimated',
    }
  }

  // ── Squat ────────────────────────────────────────────────────────────────
  // Use thigh length: hip→knee.
  if (liftId === 'squat') {
    const realThighM = heightM * BODY_RATIOS.thigh

    if (view === 'front') {
      const leftNorm  = sideThighNorm(landmarks, 'left')
      const rightNorm = sideThighNorm(landmarks, 'right')
      const values    = [leftNorm, rightNorm].filter(validDistance)

      if (values.length === 0) return null

      const avgNorm = values.reduce((a, b) => a + b, 0) / values.length

      return {
        metresPerNormUnit: realThighM / avgNorm,
        source: 'height-estimate',
        segment: 'thigh',
        confidence: 'estimated',
      }
    }

    const thighNorm = sideThighNorm(landmarks, side)
    if (!validDistance(thighNorm)) return null

    return {
      metresPerNormUnit: realThighM / thighNorm,
      source: 'height-estimate',
      segment: 'thigh',
      confidence: 'estimated',
    }
  }

  // ── Deadlift ─────────────────────────────────────────────────────────────
  // Use shin length: knee→ankle.
  if (liftId === 'deadlift') {
    const realShinM = heightM * BODY_RATIOS.shin

    if (view === 'front') {
      const leftNorm  = sideShinNorm(landmarks, 'left')
      const rightNorm = sideShinNorm(landmarks, 'right')
      const values    = [leftNorm, rightNorm].filter(validDistance)

      if (values.length === 0) return null

      const avgNorm = values.reduce((a, b) => a + b, 0) / values.length

      return {
        metresPerNormUnit: realShinM / avgNorm,
        source: 'height-estimate',
        segment: 'shin',
        confidence: 'estimated',
      }
    }

    const shinNorm = sideShinNorm(landmarks, side)
    if (!validDistance(shinNorm)) return null

    return {
      metresPerNormUnit: realShinM / shinNorm,
      source: 'height-estimate',
      segment: 'shin',
      confidence: 'estimated',
    }
  }

  return null
}