import { computeAngles, checkDepth, pickBestSide,
         lateralityScore, classifyCamera,
         handFootDistance, euclideanDistance,
         benchPickBestSide, computeElbowAngle,
         getBenchSideLandmarkKeys, areVisible,
         updateHysteresis } from './poseUtils.js'

import { ConcentricVelocityTracker } from './velocityTracker.js'
import { estimateMetresPerNormUnit } from './velocityScale.js'
import { DownwardMovementDetector, getWristProxyY } from './downwardMovement.js'

// ── Enums ─────────────────────────────────────────────────────────────────────
export const SquatState = {
  WAITING:        'WAITING',
  SETUP:          'SETUP',
  DESCENDING:     'DESCENDING',
  DEPTH_ACHIEVED: 'DEPTH_ACHIEVED',
  ASCENDING:      'ASCENDING',
  LOCKOUT:        'LOCKOUT',
  COMPLETE:       'COMPLETE',
}

export const LiftResult = {
  PENDING: 'PENDING',
  WHITE:   'WHITE',
  RED:     'RED',
}

export const STATE_MESSAGES = {
  [SquatState.WAITING]:        'READY — Stand in frame',
  [SquatState.SETUP]:          'DETECTED — Hold still',
  [SquatState.DESCENDING]:     'SQUAT ▼',
  [SquatState.DEPTH_ACHIEVED]: 'DEPTH ✓',
  [SquatState.ASCENDING]:      'ASCENDING ▲',
  [SquatState.LOCKOUT]:        'STAND TALL — Hold still',
  [SquatState.COMPLETE]:       'SET COMPLETE',
}

// ── StillnessDetector ─────────────────────────────────────────────────────────
class StillnessDetector {
  constructor(landmarkNames, requiredFrames = 30, threshold = 0.02) {
    this.landmarkNames  = landmarkNames
    this.requiredFrames = requiredFrames
    this.threshold      = threshold
    this._history       = {}
    this._stillFrames   = 0
    this._initHistory()
  }

  _initHistory() {
    this._history = {}
    for (const name of this.landmarkNames) {
      this._history[name] = []
    }
  }

  update(landmarks) {
    let allStill = true

    for (const name of this.landmarkNames) {
      if (!landmarks[name]) { allStill = false; continue }

      const pos     = { x: landmarks[name].x, y: landmarks[name].y }
      const history = this._history[name]

      history.push(pos)
      if (history.length > this.requiredFrames) history.shift()

      if (history.length < this.requiredFrames) { allStill = false; continue }

      const xs      = history.map(p => p.x)
      const ys      = history.map(p => p.y)
      const spreadX = Math.max(...xs) - Math.min(...xs)
      const spreadY = Math.max(...ys) - Math.min(...ys)

      if (spreadX > this.threshold || spreadY > this.threshold) {
        allStill = false
      }
    }

    if (allStill) {
      this._stillFrames = Math.min(this._stillFrames + 1, this.requiredFrames)
    } else {
      this._stillFrames = Math.max(this._stillFrames - 2, 0)
    }

    return {
      isStill:  allStill,
      progress: this._stillFrames / this.requiredFrames,
    }
  }

  reset() {
    this._initHistory()
    this._stillFrames = 0
  }
}

// ── Visibility policy helpers ─────────────────────────────────────────────────
function squatRequiredKeys(side) {
  return [
    `${side}_shoulder`,
    `${side}_hip`,
    `${side}_knee`,
    `${side}_ankle`,
  ]
}

function deadliftRequiredKeys(angle, side) {
  if (angle === 'front') {
    return [
      'left_wrist',  'right_wrist',
      'left_knee',   'right_knee',
      'left_ankle',  'right_ankle',
    ]
  }
  return [
    `${side}_shoulder`,
    `${side}_hip`,
    `${side}_knee`,
    `${side}_ankle`,
    `${side}_wrist`,
  ]
}

function benchRequiredKeys(angle, side) {
  if (angle === 'front') {
    return [
      'left_shoulder',  'left_elbow',  'left_wrist',
      'right_shoulder', 'right_elbow', 'right_wrist',
    ]
  }
  return [
    `${side}_shoulder`,
    `${side}_elbow`,
    `${side}_wrist`,
  ]
}

function visibilityCheck(label, visible) {
  return { label, passed: visible }
}

// ── SquatReferee ──────────────────────────────────────────────────────────────
export class SquatReferee {
  constructor(
    onCommand,
    totalReps = 1,
    angle = 'side',
    userProfile = null,
    stillnessFrames = 30,
    stillnessThreshold = 0.02
  ) {
    // ── Thresholds with hysteresis ──────────────────────────────────────────
    // Fix 2: separate enter/exit thresholds prevent oscillation at boundary.
    this.KNEE_LOCK_ENTER    = 165
    this.KNEE_LOCK_EXIT     = 155
    this.HIP_UPRIGHT_ENTER  = 150
    this.HIP_UPRIGHT_EXIT   = 140

    // Fix 3: minimum frames knee/hip must be locked before lockout confirmed.
    this.LOCKOUT_HOLD_FRAMES = 6

    this.SETUP_HOLD_SECONDS = 2.0

    this.onCommand          = onCommand
    this.totalReps          = totalReps
    this.angle              = angle.toLowerCase()
    this.userProfile        = userProfile
    this.stillnessFrames    = stillnessFrames
    this.stillnessThreshold = stillnessThreshold

    this._reset()
  }

  _reset() {
    this.state           = SquatState.WAITING
    this.result          = LiftResult.PENDING
    this.currentRep      = 0
    this.repResults      = []
    this._setupEntryTime = null
    this._hasMoved       = false
    this._depthAchieved  = false
    this._faults         = []
    this._lastSide       = null

    // Fix 2: hysteresis state
    this._kneeLocked     = false
    this._hipUpright     = false

    // Fix 3: lockout hold frames counter
    this._lockoutFrames       = 0
    this._lockoutConfirmed    = false

    this._velocityTracker     = new ConcentricVelocityTracker()
    this._downwardDetector    = new DownwardMovementDetector(0.025, 4)
    this._latestScale         = null
    this._detector            = new StillnessDetector(
      [], this.stillnessFrames, this.stillnessThreshold
    )
  }

  reset() {
    this._reset()
  }

  _updateDetector(landmarks, side) {
    const keys = [`${side}_hip`, `${side}_knee`]
    if (this._lastSide !== side) {
      this._detector = new StillnessDetector(
        keys, this.stillnessFrames, this.stillnessThreshold
      )
      this._lastSide = side
    }
    const subset = {}
    for (const key of keys) subset[key] = landmarks[key]
    return this._detector.update(subset)
  }

  _addFault(fault) {
    if (!this._faults.includes(fault)) {
      this._faults.push(fault)
    }
  }

  _giveCommand(command) {
    this.onCommand(command)
    console.log(`>>> ${command.toUpperCase()} <<<`)
  }

  _completeRep() {
    const repResult = this._depthAchieved && this._faults.length === 0
      ? LiftResult.WHITE : LiftResult.RED

    const reasons = this._depthAchieved
      ? [...this._faults]
      : ['No depth', ...this._faults]

    this.repResults.push({
      rep:      this.currentRep,
      result:   repResult,
      faults:   repResult === LiftResult.RED ? reasons : [],
      velocity: this._velocityTracker.getMetrics(this._latestScale),
    })
  }

  _resetForNextRep() {
    this._depthAchieved   = false
    this._hasMoved        = false
    this._faults          = []
    this._setupEntryTime  = null
    this._lockoutFrames   = 0
    this._lockoutConfirmed = false
    this._velocityTracker.reset()
    this._downwardDetector.reset()
    this._detector.reset()
  }

  update(landmarks) {
    const side = pickBestSide(landmarks)
    if (!side) return this._emptyReturn()

    const requiredKeys  = squatRequiredKeys(side)
    const jointsVisible = areVisible(landmarks, requiredKeys)

    if (!jointsVisible) {
      return {
        state:      this.state,
        result:     this.result,
        progress:   0,
        isStill:    false,
        checks:     [visibilityCheck('Required joints visible', false)],
        currentRep: this.currentRep,
        totalReps:  this.totalReps,
        repResults: this.repResults,
        side,
        camera:     null,
      }
    }

    const score       = lateralityScore(landmarks)
    const camera      = classifyCamera(score)
    const angles      = computeAngles(landmarks, side)
    const { atDepth } = checkDepth(landmarks, side, camera)
    const { isStill, progress } = this._updateDetector(landmarks, side)

    // Fix 2: update hysteresis state for knee and hip
    this._kneeLocked = updateHysteresis(
      this._kneeLocked,
      angles.knee,
      this.KNEE_LOCK_ENTER,
      this.KNEE_LOCK_EXIT
    )

    this._hipUpright = updateHysteresis(
      this._hipUpright,
      angles.hip,
      this.HIP_UPRIGHT_ENTER,
      this.HIP_UPRIGHT_EXIT
    )

    const kneeLocked = this._kneeLocked
    const hipUpright = this._hipUpright

    this._latestScale = estimateMetresPerNormUnit(
      'squat', this.angle, landmarks, side, this.userProfile
    )

    // Fix 3: lockout hold frame tracking
    if (kneeLocked && hipUpright) {
      this._lockoutFrames = Math.min(
        this._lockoutFrames + 1,
        this.LOCKOUT_HOLD_FRAMES + 1
      )
    } else {
      this._lockoutFrames = 0
      this._lockoutConfirmed = false
    }

    const lockoutConfirmed = this._lockoutFrames >= this.LOCKOUT_HOLD_FRAMES

    if (this.state === SquatState.WAITING) {
      if (lockoutConfirmed) {
        this.state = SquatState.SETUP
      }

    } else if (this.state === SquatState.SETUP) {
      if (!lockoutConfirmed) {
        this.state           = SquatState.WAITING
        this._setupEntryTime = null
      } else if (isStill) {
        if (this._setupEntryTime === null) {
          this._setupEntryTime = Date.now()
        }
        const heldFor = (Date.now() - this._setupEntryTime) / 1000
        if (heldFor >= this.SETUP_HOLD_SECONDS) {
          this.currentRep++
          this._giveCommand('squat')
          this.state     = SquatState.DESCENDING
          this._hasMoved = false
          this._lockoutFrames = 0
          this._detector.reset()
        }
      } else {
        this._setupEntryTime = null
      }

    } else if (this.state === SquatState.DESCENDING) {
      if (!kneeLocked) this._hasMoved = true

      if (atDepth) {
        this._depthAchieved = true
        this.state          = SquatState.DEPTH_ACHIEVED
      } else if (this._hasMoved && lockoutConfirmed && isStill) {
        this._addFault('Knees re-locked before depth')
        this.state = SquatState.LOCKOUT
      }

    } else if (this.state === SquatState.DEPTH_ACHIEVED) {
      if (!atDepth) {
        const hipY = landmarks[`${side}_hip`]?.y
        this._velocityTracker.start(hipY)

        const wristY = getWristProxyY(landmarks)
        if (wristY !== null) this._downwardDetector.start(wristY)

        this.state = SquatState.ASCENDING
      }

    } else if (this.state === SquatState.ASCENDING) {
      const hipY = landmarks[`${side}_hip`]?.y
      this._velocityTracker.add(hipY)

      const wristY = getWristProxyY(landmarks)
      if (wristY !== null) {
        if (!this._downwardDetector.active) {
          this._downwardDetector.start(wristY)
        } else if (this._downwardDetector.update(wristY)) {
          this._addFault('Downward movement after ascent began')
        }
      }

      // Fix 3: only transition to lockout once confirmed for N frames
      if (lockoutConfirmed) this.state = SquatState.LOCKOUT

    } else if (this.state === SquatState.LOCKOUT) {
      if (!kneeLocked) {
        this.state = SquatState.ASCENDING
      } else if (isStill) {
        this._completeRep()

        if (this.currentRep >= this.totalReps) {
          this._giveCommand('rack')
          this.result = LiftResult.WHITE
          this.state  = SquatState.COMPLETE
        } else {
          this._resetForNextRep()
          this.currentRep++
          this._giveCommand('squat')
          this.state     = SquatState.DESCENDING
          this._hasMoved = false
        }
      }

    } else if (this.state === SquatState.COMPLETE) {
      // stay complete
    }

    const checks = [
      { label: 'Joints visible', passed: jointsVisible        },
      { label: 'Hips upright',   passed: hipUpright           },
      { label: 'Knees locked',   passed: kneeLocked           },
      { label: 'Still',          passed: isStill              },
      { label: 'Depth',          passed: this._depthAchieved  },
    ]

    return {
      state:      this.state,
      result:     this.result,
      progress,
      isStill,
      checks,
      currentRep: this.currentRep,
      totalReps:  this.totalReps,
      repResults: this.repResults,
      side,
      camera,
      angles,
    }
  }

  _emptyReturn() {
    return {
      state:      this.state,
      result:     this.result,
      progress:   0,
      isStill:    false,
      checks:     [],
      currentRep: this.currentRep,
      totalReps:  this.totalReps,
      repResults: this.repResults,
      side:       null,
      camera:     null,
    }
  }
}

// ── Deadlift States ───────────────────────────────────────────────────────────
export const DeadliftState = {
  WAITING:  'WAITING',
  SETUP:    'SETUP',
  PULLING:  'PULLING',
  LOCKOUT:  'LOCKOUT',
  COMPLETE: 'COMPLETE',
}

export const DEADLIFT_STATE_MESSAGES = {
  [DeadliftState.WAITING]:  'READY — Get into position',
  [DeadliftState.SETUP]:    'SETUP — Pull when ready',
  [DeadliftState.PULLING]:  'PULLING ▲',
  [DeadliftState.LOCKOUT]:  'HOLD — Stand tall',
  [DeadliftState.COMPLETE]: 'SET COMPLETE',
}

// ── DeadliftReferee ───────────────────────────────────────────────────────────
export class DeadliftReferee {
  constructor(
    onCommand,
    totalReps = 1,
    angle = 'side',
    stillnessFrames = 30,
    stillnessThreshold = 0.02,
    userProfile = null
  ) {
    // Fix 2: hysteresis thresholds
    this.KNEE_LOCK_ENTER      = 160
    this.KNEE_LOCK_EXIT       = 150
    this.HIP_LOCK_ANGLE       = 120
    this.HIP_LOCK_EXIT        = 110
    this.FRONT_KNEE_LOCK_ENTER = 172
    this.FRONT_KNEE_LOCK_EXIT  = 162

    this.HINGE_HIP_ANGLE      = 130
    this.HINGE_KNEE_ANGLE     = 150
    this.SHOULDER_FORWARD_MAX = 20

    this.HAND_FOOT_SETUP_THRESHOLD = 0.3
    this.HAND_FOOT_PULL_THRESHOLD  = 0.45

    // Fix 3: hold frames for lockout confirmation
    this.LOCKOUT_HOLD_FRAMES  = 20
    this.PULL_FRAMES_REQUIRED = 4

    this.onCommand          = onCommand
    this.totalReps          = totalReps
    this.angle              = angle.toLowerCase()
    this.userProfile        = userProfile
    this.stillnessFrames    = stillnessFrames
    this.stillnessThreshold = stillnessThreshold

    this._reset()
  }

  _reset() {
    this.state              = DeadliftState.WAITING
    this.result             = LiftResult.PENDING
    this.currentRep         = 0
    this.repResults         = []
    this._faults            = []
    this._lockoutFrames     = 0
    this._lockoutFired      = false
    this._hipAngleHistory   = []
    this._handDistHistory   = []
    this._confirmedHinge    = false
    this._lastSide          = null

    // Fix 2: hysteresis state
    this._kneeLocked        = false
    this._hipLocked         = false

    this._velocityTracker   = new ConcentricVelocityTracker()
    this._downwardDetector  = new DownwardMovementDetector(0.015, 4)
    this._latestScale       = null
    this._detector          = new StillnessDetector(
      [], this.stillnessFrames, this.stillnessThreshold
    )
  }

  reset() {
    this._reset()
  }

  _updateDetector(landmarks, side) {
    const keys = [`${side}_hip`, `${side}_knee`]
    if (this._lastSide !== side) {
      this._detector = new StillnessDetector(
        keys, this.stillnessFrames, this.stillnessThreshold
      )
      this._lastSide = side
    }
    const subset = {}
    for (const key of keys) subset[key] = landmarks[key]
    return this._detector.update(subset)
  }

  _addFault(fault) {
    if (!this._faults.includes(fault)) this._faults.push(fault)
  }

  _giveCommand(command) {
    this.onCommand(command)
    console.log(`>>> ${command.toUpperCase()} <<<`)
  }

  _completeRep() {
    const repResult = this._faults.length === 0
      ? LiftResult.WHITE : LiftResult.RED

    this.repResults.push({
      rep:      this.currentRep,
      result:   repResult,
      faults:   repResult === LiftResult.RED ? [...this._faults] : [],
      velocity: this._velocityTracker.getMetrics(this._latestScale),
    })
  }

  _resetForNextRep() {
    this._faults          = []
    this._lockoutFrames   = 0
    this._lockoutFired    = false
    this._hipAngleHistory = []
    this._handDistHistory = []
    this._confirmedHinge  = false
    this._kneeLocked      = false
    this._hipLocked       = false
    this._velocityTracker.reset()
    this._downwardDetector.reset()
  }

  _getDeadliftVelocityY(landmarks, side) {
    if (this.angle === 'side') {
      return landmarks[`${side}_wrist`]?.y ?? null
    }
    const left  = landmarks.left_wrist
    const right = landmarks.right_wrist
    if (!left || !right) return null
    return (left.y + right.y) / 2
  }

  _isHipLocked(landmarks, side, angles) {
    if (angles.hip >= this.HIP_LOCK_ANGLE) return true
    const shoulderX = landmarks[`${side}_shoulder`].x
    const hipX      = landmarks[`${side}_hip`].x
    return side === 'left'
      ? hipX < shoulderX + 0.05
      : hipX > shoulderX - 0.05
  }

  _isShouldersBack(landmarks, side) {
    const shoulder = landmarks[`${side}_shoulder`]
    const hip      = landmarks[`${side}_hip`]
    if (!shoulder || !hip) return true
    const dx         = shoulder.x - hip.x
    const dy         = shoulder.y - hip.y
    const torsoAngle = Math.atan2(dx, -dy) * 180 / Math.PI
    const lean       = side === 'left' ? torsoAngle : -torsoAngle
    return lean < this.SHOULDER_FORWARD_MAX
  }

  _isSustainedPullSide() {
    if (this._hipAngleHistory.length < this.PULL_FRAMES_REQUIRED) return false
    const recent = this._hipAngleHistory.slice(-this.PULL_FRAMES_REQUIRED)
    let rising = 0
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) rising++
    }
    return rising >= this.PULL_FRAMES_REQUIRED - 1
  }

  _isSustainedPullFront() {
    if (this._handDistHistory.length < this.PULL_FRAMES_REQUIRED) return false
    const recent = this._handDistHistory.slice(-this.PULL_FRAMES_REQUIRED)
    let rising = 0
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) rising++
    }
    return rising >= this.PULL_FRAMES_REQUIRED - 1
  }

  update(landmarks) {
    const side = pickBestSide(landmarks)
    if (!side) return this._emptyReturn()

    const requiredKeys  = deadliftRequiredKeys(this.angle, side)
    const jointsVisible = areVisible(landmarks, requiredKeys)

    if (!jointsVisible) {
      return {
        state:      this.state,
        result:     this.result,
        progress:   0,
        isStill:    false,
        checks:     [visibilityCheck('Required joints visible', false)],
        currentRep: this.currentRep,
        totalReps:  this.totalReps,
        repResults: this.repResults,
        side,
      }
    }

    const score  = lateralityScore(landmarks)
    const camera = classifyCamera(score)
    const angles = computeAngles(landmarks, side)
    const { isStill, progress } = this._updateDetector(landmarks, side)

    this._latestScale = estimateMetresPerNormUnit(
      'deadlift', this.angle, landmarks, side, this.userProfile
    )

    let kneeLocked    = false
    let hipLocked     = false
    let shouldersBack = true
    let isHinged      = false
    let sustainedPull = false

    if (this.angle === 'side') {
      // Fix 2: hysteresis on knee and hip locked
      this._kneeLocked = updateHysteresis(
        this._kneeLocked, angles.knee,
        this.KNEE_LOCK_ENTER, this.KNEE_LOCK_EXIT
      )

      const hipLockedRaw = this._isHipLocked(landmarks, side, angles)
      this._hipLocked = updateHysteresis(
        this._hipLocked,
        hipLockedRaw ? this.HIP_LOCK_ANGLE + 1 : 0,
        this.HIP_LOCK_ANGLE,
        this.HIP_LOCK_EXIT
      )

      kneeLocked    = this._kneeLocked
      hipLocked     = this._hipLocked || this._isHipLocked(landmarks, side, angles)
      shouldersBack = this._isShouldersBack(landmarks, side)
      isHinged      = angles.hip < this.HINGE_HIP_ANGLE &&
                      angles.knee < this.HINGE_KNEE_ANGLE

      this._hipAngleHistory.push(angles.hip)
      if (this._hipAngleHistory.length > 10) this._hipAngleHistory.shift()
      sustainedPull = this._isSustainedPullSide()

    } else {
      // Fix 2: hysteresis on front-view knee
      this._kneeLocked = updateHysteresis(
        this._kneeLocked, angles.knee,
        this.FRONT_KNEE_LOCK_ENTER, this.FRONT_KNEE_LOCK_EXIT
      )

      kneeLocked = this._kneeLocked
      hipLocked  = true

      const handDist = handFootDistance(landmarks)
      this._handDistHistory.push(handDist)
      if (this._handDistHistory.length > 10) this._handDistHistory.shift()

      isHinged      = handDist < this.HAND_FOOT_SETUP_THRESHOLD
      sustainedPull = this._isSustainedPullFront()
    }

    if (this.state === DeadliftState.WAITING) {
      if (isHinged) {
        this._confirmedHinge  = false
        this._hipAngleHistory = []
        this._handDistHistory = []
        this.state            = DeadliftState.SETUP
      }

    } else if (this.state === DeadliftState.SETUP) {
      if (isHinged) this._confirmedHinge = true

      if (this._confirmedHinge && sustainedPull) {
        this._hipAngleHistory = []
        this._handDistHistory = []

        const y = this._getDeadliftVelocityY(landmarks, side)
        this._velocityTracker.start(y)

        const wristY = getWristProxyY(landmarks)
        if (wristY !== null) this._downwardDetector.start(wristY)

        this.currentRep++
        this.state = DeadliftState.PULLING
      }

      if (kneeLocked && hipLocked && !this._confirmedHinge) {
        this.state = DeadliftState.WAITING
      }

    } else if (this.state === DeadliftState.PULLING) {
      const y = this._getDeadliftVelocityY(landmarks, side)
      this._velocityTracker.add(y)

      const wristY = getWristProxyY(landmarks)
      if (wristY !== null) {
        if (!this._downwardDetector.active) {
          this._downwardDetector.start(wristY)
        } else if (this._downwardDetector.update(wristY)) {
          this._addFault('Downward movement during pull')
        }
      }

      if (kneeLocked && hipLocked) {
        this.state          = DeadliftState.LOCKOUT
        this._lockoutFrames = 0
        this._lockoutFired  = false
      }

    } else if (this.state === DeadliftState.LOCKOUT) {
      if (!kneeLocked || !hipLocked) {
        this.state          = DeadliftState.PULLING
        this._lockoutFrames = 0
        this._lockoutFired  = false
      } else {
        this._lockoutFrames++

        if (this._lockoutFrames >= this.LOCKOUT_HOLD_FRAMES && !this._lockoutFired) {
          this._lockoutFired = true

          if (!kneeLocked)    this._addFault('Knees not locked')
          if (!hipLocked)     this._addFault('Hips not through')
          if (!shouldersBack) this._addFault('Shoulders not back')

          this._giveCommand('down')
          this._completeRep()

          if (this.currentRep >= this.totalReps) {
            this.result = LiftResult.WHITE
            this.state  = DeadliftState.COMPLETE
          } else {
            this._resetForNextRep()
            this._hipAngleHistory = []
            this._handDistHistory = []
            this._confirmedHinge  = false
            this.state            = DeadliftState.SETUP
          }
        }
      }

    } else if (this.state === DeadliftState.COMPLETE) {
      // stay complete
    }

    const checks = this.angle === 'side'
      ? [
          { label: 'Joints visible', passed: jointsVisible },
          { label: 'Knees locked',   passed: kneeLocked    },
          { label: 'Hips through',   passed: hipLocked      },
          { label: 'Shoulders back', passed: shouldersBack  },
          { label: 'Still',          passed: isStill        },
        ]
      : [
          { label: 'Joints visible', passed: jointsVisible },
          { label: 'Knees locked',   passed: kneeLocked    },
          { label: 'Still',          passed: isStill        },
        ]

    return {
      state:      this.state,
      result:     this.result,
      progress,
      isStill,
      checks,
      currentRep: this.currentRep,
      totalReps:  this.totalReps,
      repResults: this.repResults,
      side,
      camera,
      angles,
    }
  }

  _emptyReturn() {
    return {
      state:      this.state,
      result:     this.result,
      progress:   0,
      isStill:    false,
      checks:     [],
      currentRep: this.currentRep,
      totalReps:  this.totalReps,
      repResults: this.repResults,
      side:       null,
    }
  }
}

// ── Bench Press States ────────────────────────────────────────────────────────
export const BenchState = {
  WAITING:    'WAITING',
  SETUP:      'SETUP',
  LOCKOUT:    'LOCKOUT',
  DESCENDING: 'DESCENDING',
  CHEST:      'CHEST',
  PRESSING:   'PRESSING',
  COMPLETE:   'COMPLETE',
}

export const BENCH_STATE_MESSAGES = {
  [BenchState.WAITING]:    'READY — Lie in frame',
  [BenchState.SETUP]:      'DETECTED — Hold still',
  [BenchState.LOCKOUT]:    'HOLD — Arms locked out',
  [BenchState.DESCENDING]: 'DESCENDING ▼',
  [BenchState.CHEST]:      'CHEST — Hold still',
  [BenchState.PRESSING]:   'PRESS ▲',
  [BenchState.COMPLETE]:   'SET COMPLETE',
}

export class BenchReferee {
  constructor(
    onCommand,
    totalReps = 1,
    angle = 'side',
    calibration = null,
    userProfile = null
  ) {
    // Fix 2: hysteresis on elbow lockout
    this.ELBOW_LOCK_ENTER      = 160
    this.ELBOW_LOCK_EXIT       = 150

    this.CHEST_RATIO_TOLERANCE = 0.08
    this.VELOCITY_THRESHOLD    = 0.004
    this.LOCKOUT_HOLD_FRAMES   = 20
    this.CHEST_HOLD_FRAMES     = 15
    this.SETUP_HOLD_FRAMES     = 25

    this.onCommand   = onCommand
    this.totalReps   = totalReps
    this.angle       = angle.toLowerCase()
    this.calibration = calibration
    this.userProfile = userProfile

    this._reset()
  }

  _reset() {
    this.state      = BenchState.WAITING
    this.result     = LiftResult.PENDING
    this.currentRep = 0
    this.repResults = []
    this._faults    = []

    this._lockedSide          = null
    this._trackedLandmarkKeys = []

    this._lockoutFrames       = 0
    this._chestFrames         = 0
    this._elbowAngleHistory   = []
    this._wristHistory        = []

    this._repInProgress       = false
    this._pendingCompletion   = false
    this._pressCommandFired   = false
    this._startCommandFired   = false
    this._chestReached        = false

    // Fix 2: hysteresis state for elbow lockout
    this._elbowLockedHyst     = false

    this._velocityTracker     = new ConcentricVelocityTracker()
    this._downwardDetector    = new DownwardMovementDetector(0.015, 4)
    this._latestScale         = null
  }

  reset() {
    this._reset()
  }

  _resetForNextRepTop() {
    this._faults              = []
    this._lockoutFrames       = 0
    this._chestFrames         = 0
    this._elbowAngleHistory   = []
    this._wristHistory        = []

    this._repInProgress       = false
    this._pendingCompletion   = false
    this._pressCommandFired   = false
    this._startCommandFired   = false
    this._chestReached        = false

    this._velocityTracker.reset()
    this._downwardDetector.reset()
  }

  _addFault(fault) {
    if (!this._faults.includes(fault)) this._faults.push(fault)
  }

  _giveCommand(command) {
    this.onCommand(command)
    console.log(`>>> ${command.toUpperCase()} <<<`)
  }

  _completeRep() {
    const repResult = this._chestReached && this._faults.length === 0
      ? LiftResult.WHITE : LiftResult.RED

    const reasons = this._chestReached
      ? [...this._faults]
      : ['Bar did not reach chest', ...this._faults]

    this.repResults.push({
      rep:      this.currentRep,
      result:   repResult,
      faults:   repResult === LiftResult.RED ? reasons : [],
      velocity: this._velocityTracker.getMetrics(this._latestScale),
    })
  }

  _updateWristHistory(landmarks, side) {
    const wrist = landmarks[`${side}_wrist`]
    if (!wrist) return Infinity

    this._wristHistory.push({ x: wrist.x, y: wrist.y })
    if (this._wristHistory.length > 5) this._wristHistory.shift()
    if (this._wristHistory.length < 2) return Infinity

    const prev = this._wristHistory[this._wristHistory.length - 2]
    const curr = this._wristHistory[this._wristHistory.length - 1]

    return Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2)
  }

  _updateElbowHistory(elbowAngle) {
    this._elbowAngleHistory.push(elbowAngle)
    if (this._elbowAngleHistory.length > 8) this._elbowAngleHistory.shift()
  }

  _elbowAtLocalMinimum() {
    const h = this._elbowAngleHistory
    if (h.length < 4) return false
    const minPrev = Math.min(...h.slice(0, -1))
    return h[h.length - 1] > minPrev + 3
  }

  _getSide(landmarks) {
    const detectedSide = benchPickBestSide(landmarks)
    if (this._lockedSide) return this._lockedSide
    return detectedSide
  }

  _lockSide(side) {
    if (!side) return
    this._lockedSide = side

    if (this.angle === 'side') {
      this._trackedLandmarkKeys = getBenchSideLandmarkKeys(side)
    } else {
      this._trackedLandmarkKeys = [
        'left_shoulder',  'left_elbow',  'left_wrist',
        'right_shoulder', 'right_elbow', 'right_wrist',
      ]
    }
  }

  _isAtChest(landmarks, side, elbowAngle, wristVelocity) {
    const wristStill = wristVelocity < this.VELOCITY_THRESHOLD

    if (this.calibration) {
      const calSide  = this.calibration.side || side
      const shoulder = landmarks[`${calSide}_shoulder`]
      const wrist    = landmarks[`${calSide}_wrist`]

      if (shoulder && wrist && this.calibration.armExtendedDistance) {
        const currentRatio =
          euclideanDistance(shoulder, wrist) / this.calibration.armExtendedDistance

        return (
          currentRatio <= this.calibration.chestRatio + this.CHEST_RATIO_TOLERANCE &&
          wristStill &&
          this._elbowAtLocalMinimum()
        )
      }
    }

    return elbowAngle < 100 && wristStill && this._elbowAtLocalMinimum()
  }

  _getBenchVelocityY(landmarks, side, barY = null) {
    if (barY != null && !Number.isNaN(barY)) return barY
    return landmarks[`${side}_wrist`]?.y ?? null
  }

  update(landmarks, barY = null) {
    const side = this._getSide(landmarks)
    if (!side) return this._emptyReturn()

    const requiredKeys  = benchRequiredKeys(this.angle, side)
    const jointsVisible = areVisible(landmarks, requiredKeys)

    if (!jointsVisible) {
      return {
        ...this._emptyReturn(),
        side,
        lockedSide: this._lockedSide,
        trackedLandmarkKeys: this._trackedLandmarkKeys,
        checks: [visibilityCheck('Required joints visible', false)],
      }
    }

    const elbowAngle = computeElbowAngle(landmarks, side)

    if (elbowAngle === null) {
      return {
        ...this._emptyReturn(),
        side,
        lockedSide: this._lockedSide,
        trackedLandmarkKeys: this._trackedLandmarkKeys,
        checks: [visibilityCheck('Required joints visible', false)],
      }
    }

    const wristVelocity = this._updateWristHistory(landmarks, side)
    const wristStill    = wristVelocity < this.VELOCITY_THRESHOLD

    // Fix 2: hysteresis on elbow lockout
    this._elbowLockedHyst = updateHysteresis(
      this._elbowLockedHyst,
      elbowAngle,
      this.ELBOW_LOCK_ENTER,
      this.ELBOW_LOCK_EXIT
    )
    const lockedOut = this._elbowLockedHyst

    this._updateElbowHistory(elbowAngle)

    const atChest = this._isAtChest(landmarks, side, elbowAngle, wristVelocity)

    this._latestScale = estimateMetresPerNormUnit(
      'bench', this.angle, landmarks, side, this.userProfile
    )

    if (this.state === BenchState.WAITING) {
      if (lockedOut) {
        this.state          = BenchState.SETUP
        this._lockoutFrames = 0
      }

    } else if (this.state === BenchState.SETUP) {
      if (!lockedOut) {
        this.state          = BenchState.WAITING
        this._lockoutFrames = 0
      } else if (wristStill) {
        this._lockoutFrames++
        if (this._lockoutFrames >= this.SETUP_HOLD_FRAMES) {
          this._lockSide(side)
          this.state              = BenchState.LOCKOUT
          this._lockoutFrames     = 0
          this._startCommandFired = false
        }
      } else {
        this._lockoutFrames = Math.max(0, this._lockoutFrames - 1)
      }

    } else if (this.state === BenchState.LOCKOUT) {
      if (this._pendingCompletion) {
        if (lockedOut && wristStill) {
          this._lockoutFrames++

          if (this._lockoutFrames >= this.LOCKOUT_HOLD_FRAMES) {
            this._pendingCompletion = false
            this._completeRep()

            if (this.currentRep >= this.totalReps) {
              this._giveCommand('rack')
              this.result = LiftResult.WHITE
              this.state  = BenchState.COMPLETE
            } else {
              this._resetForNextRepTop()
              this.state = BenchState.LOCKOUT
            }
          }
        } else {
          this._lockoutFrames = Math.max(0, this._lockoutFrames - 1)
        }

      } else if (!this._repInProgress && this.currentRep < this.totalReps) {
        if (lockedOut && wristStill && !this._startCommandFired) {
          this._lockoutFrames++

          if (this._lockoutFrames >= this.LOCKOUT_HOLD_FRAMES) {
            this._giveCommand('start')
            this._startCommandFired = true
            this._lockoutFrames     = 0
          }
        }

        if (!lockedOut) {
          this.currentRep++
          this._repInProgress     = true
          this._chestReached      = false
          this._pressCommandFired = false
          this._lockoutFrames     = 0
          this._chestFrames       = 0
          this._elbowAngleHistory = []
          this._wristHistory      = []
          this.state              = BenchState.DESCENDING
        }
      }

    } else if (this.state === BenchState.DESCENDING) {
      if (atChest) {
        this._chestReached = true
        this._chestFrames  = 0
        this.state         = BenchState.CHEST
      }

      if (lockedOut && this._repInProgress && !this._chestReached) {
        this._addFault('Bar did not reach chest')
        this._pendingCompletion = true
        this._lockoutFrames     = 0
        this.state              = BenchState.LOCKOUT
      }

    } else if (this.state === BenchState.CHEST) {
      if (atChest && wristStill) {
        this._chestFrames++

        if (this._chestFrames >= this.CHEST_HOLD_FRAMES && !this._pressCommandFired) {
          this._giveCommand('press')
          this._pressCommandFired = true
        }

      } else if (!atChest && !wristStill) {
        const y = this._getBenchVelocityY(landmarks, side, barY)
        this._velocityTracker.start(y)

        const wristY = getWristProxyY(landmarks)
        if (wristY !== null) this._downwardDetector.start(wristY)

        this.state = BenchState.PRESSING
      }

    } else if (this.state === BenchState.PRESSING) {
      const y = this._getBenchVelocityY(landmarks, side, barY)
      this._velocityTracker.add(y)

      const wristY = getWristProxyY(landmarks)
      if (wristY !== null) {
        if (!this._downwardDetector.active) {
          this._downwardDetector.start(wristY)
        } else if (this._downwardDetector.update(wristY)) {
          this._addFault('Downward movement during press')
        }
      }

      if (atChest) {
        this.state = BenchState.CHEST
      }

      if (lockedOut) {
        this._pendingCompletion = true
        this._lockoutFrames     = 0
        this.state              = BenchState.LOCKOUT
      }

    } else if (this.state === BenchState.COMPLETE) {
      // stay complete
    }

    return this._buildReturn(side, elbowAngle, wristVelocity, atChest, barY)
  }

  _buildReturn(side, elbowAngle, wristVelocity, atChest, barY = null) {
    const wristStill = wristVelocity < this.VELOCITY_THRESHOLD
    const lockedOut  = this._elbowLockedHyst

    const progress = this.state === BenchState.SETUP
      ? this._lockoutFrames / this.SETUP_HOLD_FRAMES
      : this.state === BenchState.CHEST
        ? this._chestFrames / this.CHEST_HOLD_FRAMES
        : this.state === BenchState.LOCKOUT
          ? this._lockoutFrames / this.LOCKOUT_HOLD_FRAMES
          : 0

    return {
      state:      this.state,
      result:     this.result,
      progress,
      checks: [
        { label: 'Arm joints visible', passed: true          },
        { label: 'Arms locked',        passed: lockedOut     },
        { label: 'Wrist still',        passed: wristStill    },
        { label: 'Bar at chest',       passed: atChest       },
        { label: 'Calibrated',         passed: this.calibration !== null },
      ],
      currentRep: this.currentRep,
      totalReps:  this.totalReps,
      repResults: this.repResults,
      side,
      lockedSide: this._lockedSide,
      trackedLandmarkKeys: this._trackedLandmarkKeys,
      elbowAngle,
      wristVelocity,
      atChest,
      barY,
    }
  }

  _emptyReturn() {
    return {
      state:      this.state,
      result:     this.result,
      progress:   0,
      checks:     [],
      currentRep: this.currentRep,
      totalReps:  this.totalReps,
      repResults: this.repResults,
      side:       null,
      lockedSide: this._lockedSide,
      trackedLandmarkKeys: this._trackedLandmarkKeys,
    }
  }
}