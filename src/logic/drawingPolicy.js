// src/logic/drawingPolicy.js
import { LANDMARK_INDICES } from './poseUtils.js'

const DEFAULT_VISIBILITY_THRESHOLD = 0.5

function rawLandmarkForName(rawLandmarks, name) {
  const index = LANDMARK_INDICES[name]
  if (index == null) return null
  return rawLandmarks[index] ?? null
}

function isRawVisible(rawLandmark, threshold = DEFAULT_VISIBILITY_THRESHOLD) {
  if (!rawLandmark) return false
  return (rawLandmark.visibility ?? 1) >= threshold
}

function connection(startName, endName) {
  return {
    start: LANDMARK_INDICES[startName],
    end:   LANDMARK_INDICES[endName],
  }
}

function sideNames(side, names) {
  return names.map(name => `${side}_${name}`)
}

function getPolicyNamesAndConnections(liftId, angle, update) {
  const view = angle.toLowerCase()

  // Prefer locked side if referee provides one.
  // Otherwise use current selected side.
  const side = update?.lockedSide || update?.side

  // ── Bench Press ───────────────────────────────────────────────────────────
  if (liftId === 'bench') {
    // Bench front view: upper body only.
    // Ignore lower body completely.
    if (view === 'front') {
      return {
        names: [
          'left_shoulder',
          'left_elbow',
          'left_wrist',
          'right_shoulder',
          'right_elbow',
          'right_wrist',
        ],
        connections: [
          connection('left_shoulder', 'left_elbow'),
          connection('left_elbow', 'left_wrist'),
          connection('right_shoulder', 'right_elbow'),
          connection('right_elbow', 'right_wrist'),
          connection('left_shoulder', 'right_shoulder'),
        ],
      }
    }

    // Bench side view:
    // selected/locked side arm drives commands;
    // selected/locked side lower body is drawn passively if visible.
    if (side === 'left' || side === 'right') {
      return {
        names: sideNames(side, [
          'shoulder',
          'elbow',
          'wrist',
          'hip',
          'knee',
          'ankle',
          'heel',
          'foot_index',
        ]),
        connections: [
          connection(`${side}_shoulder`, `${side}_elbow`),
          connection(`${side}_elbow`, `${side}_wrist`),

          connection(`${side}_shoulder`, `${side}_hip`),
          connection(`${side}_hip`, `${side}_knee`),
          connection(`${side}_knee`, `${side}_ankle`),

          connection(`${side}_ankle`, `${side}_heel`),
          connection(`${side}_ankle`, `${side}_foot_index`),
          connection(`${side}_heel`, `${side}_foot_index`),
        ],
      }
    }

    return { names: [], connections: [] }
  }

  // ── Squat ─────────────────────────────────────────────────────────────────
  if (liftId === 'squat') {
    // Squat front view: both lower-body chains + shoulders/hips.
    if (view === 'front') {
      return {
        names: [
          'left_shoulder',
          'right_shoulder',
          'left_hip',
          'right_hip',
          'left_knee',
          'right_knee',
          'left_ankle',
          'right_ankle',
          'left_heel',
          'right_heel',
          'left_foot_index',
          'right_foot_index',
        ],
        connections: [
          connection('left_shoulder', 'right_shoulder'),
          connection('left_hip', 'right_hip'),

          connection('left_shoulder', 'left_hip'),
          connection('left_hip', 'left_knee'),
          connection('left_knee', 'left_ankle'),
          connection('left_ankle', 'left_heel'),
          connection('left_ankle', 'left_foot_index'),
          connection('left_heel', 'left_foot_index'),

          connection('right_shoulder', 'right_hip'),
          connection('right_hip', 'right_knee'),
          connection('right_knee', 'right_ankle'),
          connection('right_ankle', 'right_heel'),
          connection('right_ankle', 'right_foot_index'),
          connection('right_heel', 'right_foot_index'),
        ],
      }
    }

    // Squat side view: selected side only.
    if (side === 'left' || side === 'right') {
      return {
        names: sideNames(side, [
          'shoulder',
          'hip',
          'knee',
          'ankle',
          'heel',
          'foot_index',
        ]),
        connections: [
          connection(`${side}_shoulder`, `${side}_hip`),
          connection(`${side}_hip`, `${side}_knee`),
          connection(`${side}_knee`, `${side}_ankle`),
          connection(`${side}_ankle`, `${side}_heel`),
          connection(`${side}_ankle`, `${side}_foot_index`),
          connection(`${side}_heel`, `${side}_foot_index`),
        ],
      }
    }

    return { names: [], connections: [] }
  }

  // ── Deadlift ──────────────────────────────────────────────────────────────
  if (liftId === 'deadlift') {
    // Deadlift front view: wrists/hands + lower body + shoulders.
    if (view === 'front') {
      return {
        names: [
          'left_shoulder',
          'right_shoulder',
          'left_elbow',
          'right_elbow',
          'left_wrist',
          'right_wrist',
          'left_hip',
          'right_hip',
          'left_knee',
          'right_knee',
          'left_ankle',
          'right_ankle',
          'left_heel',
          'right_heel',
          'left_foot_index',
          'right_foot_index',
        ],
        connections: [
          connection('left_shoulder', 'right_shoulder'),
          connection('left_hip', 'right_hip'),

          connection('left_shoulder', 'left_elbow'),
          connection('left_elbow', 'left_wrist'),
          connection('right_shoulder', 'right_elbow'),
          connection('right_elbow', 'right_wrist'),

          connection('left_shoulder', 'left_hip'),
          connection('left_hip', 'left_knee'),
          connection('left_knee', 'left_ankle'),
          connection('left_ankle', 'left_heel'),
          connection('left_ankle', 'left_foot_index'),
          connection('left_heel', 'left_foot_index'),

          connection('right_shoulder', 'right_hip'),
          connection('right_hip', 'right_knee'),
          connection('right_knee', 'right_ankle'),
          connection('right_ankle', 'right_heel'),
          connection('right_ankle', 'right_foot_index'),
          connection('right_heel', 'right_foot_index'),
        ],
      }
    }

    // Deadlift side view: selected side only.
    if (side === 'left' || side === 'right') {
      return {
        names: sideNames(side, [
          'shoulder',
          'elbow',
          'wrist',
          'hip',
          'knee',
          'ankle',
          'heel',
          'foot_index',
        ]),
        connections: [
          connection(`${side}_shoulder`, `${side}_elbow`),
          connection(`${side}_elbow`, `${side}_wrist`),

          connection(`${side}_shoulder`, `${side}_hip`),
          connection(`${side}_hip`, `${side}_knee`),
          connection(`${side}_knee`, `${side}_ankle`),

          connection(`${side}_ankle`, `${side}_heel`),
          connection(`${side}_ankle`, `${side}_foot_index`),
          connection(`${side}_heel`, `${side}_foot_index`),
        ],
      }
    }

    return { names: [], connections: [] }
  }

  return { names: [], connections: [] }
}

/**
 * Draw only:
 * - landmarks relevant to the lift/view
 * - landmarks currently visible above threshold
 * - connectors where both endpoint landmarks are visible
 */
export function drawRelevantVisiblePose({
  drawingUtils,
  rawLandmarks,
  liftId,
  angle,
  update,
  landmarkStyle = { color: '#FF0000', lineWidth: 1, radius: 3 },
  connectorStyle = { color: '#00FF00', lineWidth: 2 },
  visibilityThreshold = DEFAULT_VISIBILITY_THRESHOLD,
}) {
  if (!drawingUtils || !rawLandmarks) return

  const { names, connections } = getPolicyNamesAndConnections(liftId, angle, update)

  const visibleLandmarks = names
    .map(name => rawLandmarkForName(rawLandmarks, name))
    .filter(lm => isRawVisible(lm, visibilityThreshold))

  const visibleConnections = connections.filter(conn => {
    if (conn.start == null || conn.end == null) return false

    const startLm = rawLandmarks[conn.start]
    const endLm   = rawLandmarks[conn.end]

    return (
      isRawVisible(startLm, visibilityThreshold) &&
      isRawVisible(endLm, visibilityThreshold)
    )
  })

  if (visibleConnections.length > 0) {
    drawingUtils.drawConnectors(
      rawLandmarks,
      visibleConnections,
      connectorStyle
    )
  }

  if (visibleLandmarks.length > 0) {
    drawingUtils.drawLandmarks(
      visibleLandmarks,
      landmarkStyle
    )
  }
}