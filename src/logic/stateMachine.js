import { computeAngles, checkDepth, pickBestSide,
         lateralityScore, classifyCamera,
         handFootDistance, euclideanDistance,
         benchPickBestSide, computeElbowAngle,
         getBenchSideLandmarkKeys } from './poseUtils.js'

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
      if (!landmarks[name]) {
        allStill = false
        continue
      }

      const pos     = { x: landmarks[name].x, y: landmarks[name].y }
      const history = this._history[name]

      history.push(pos)
      if (history.length > this.requiredFrames) history.shift()

      if (history.length < this.requiredFrames) {
        allStill = false
        continue
      }

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
      progress: this._stillFrames / this.requiredFrames
    }
  }

  reset() {
    this._initHistory()
    this._stillFrames = 0
  }
}

// ── ConcentricVelocityTracker ────────────────────────────────────────────────
// Tracks upward/concentric velocity in normalised screen units per second.
// y decreases as the lifter/bar moves upward, so positive velocity = previousY - currentY.
class ConcentricVelocityTracker {
  constructor() {
    this.reset()
  }

  reset() {
    this.samples = []
    this.started = false
  }

  start(y) {
    const t = performance.now()
    this.samples = [{ t, y }]
    this.started = true
  }

  add(y) {
    if (!this.started || y == null || Number.isNaN(y)) return

    const t = performance.now()
    const last = this.samples[this.samples.length - 1]

    // Avoid duplicate/zero-time samples
    if (!last || t <= last.t) return

    this.samples.push({ t, y })

    // Keep memory bounded
    if (this.samples.length > 300) this.samples.shift()
  }

  getMetrics() {
    if (!this.started || this.samples.length < 2) {
      return null
    }

    const first = this.samples[0]
    const last  = this.samples[this.samples.length - 1]

    const durationSec = (last.t - first.t) / 1000
    if (durationSec <= 0) return null

    // Positive distance = upward displacement
    const distanceNorm = first.y - last.y
    const avgVelocityNorm = distanceNorm / durationSec

    let peakVelocityNorm = 0

    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1]
      const curr = this.samples[i]
      const dt   = (curr.t - prev.t) / 1000
      if (dt <= 0) continue

      const v = (prev.y - curr.y) / dt

      // Only count upward/concentric velocity
      if (v > peakVelocityNorm) {
        peakVelocityNorm = v
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

// ── SquatReferee ──────────────────────────────────────────────────────────────
export class SquatReferee {
  constructor(onCommand, totalReps = 1, stillnessFrames = 30, stillnessThreshold = 0.02) {
    this.KNEE_LOCK_ANGLE    = 165
    this.HIP_UPRIGHT_ANGLE  = 150
    this.SETUP_HOLD_SECONDS = 2.0

    this.onCommand          = onCommand
    this.totalReps          = totalReps
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
    this._velocityTracker = new ConcentricVelocityTracker()
    this._detector       = new StillnessDetector(
      [], this.stillnessFrames, this.stillnessThreshold
    )
  }

  reset() {
    this._reset()
    console.log('[RESET] Ready for next set.')
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
      console.log(`[FAULT] Rep ${this.currentRep}: ${fault}`)
    }
  }

  _giveCommand(command) {
    this.onCommand(command)
    console.log(`>>> ${command.toUpperCase()} <<<`)
  }

  _completeRep() {
    const repResult = this._depthAchieved && this._faults.length === 0
      ? LiftResult.WHITE
      : LiftResult.RED

    const reasons = this._depthAchieved
      ? [...this._faults]
      : ['No depth', ...this._faults]

    this.repResults.push({
      rep:    this.currentRep,
      result: repResult,
      faults: repResult === LiftResult.RED ? reasons : [],
      velocity: this._velocityTracker.getMetrics(),
    })

    console.log(`[REP ${this.currentRep}] ${repResult}${repResult === LiftResult.RED ? ' — ' + reasons.join(', ') : ''}`)
  }

  _resetForNextRep() {
    this._depthAchieved  = false
    this._hasMoved       = false
    this._faults         = []
    this._setupEntryTime = null
    this._velocityTracker.reset()
    this._detector.reset()
  }

  update(landmarks) {
    const side = pickBestSide(landmarks)
    if (!side) {
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

    const score       = lateralityScore(landmarks)
    const camera      = classifyCamera(score)
    const angles      = computeAngles(landmarks, side)
    const { atDepth } = checkDepth(landmarks, side, camera)
    const { isStill, progress } = this._updateDetector(landmarks, side)

    const kneeLocked = angles.knee >= this.KNEE_LOCK_ANGLE
    const hipUpright = angles.hip  >= this.HIP_UPRIGHT_ANGLE

    if (this.state === SquatState.WAITING) {
      if (kneeLocked && hipUpright) {
        this.state = SquatState.SETUP
      }

    } else if (this.state === SquatState.SETUP) {
      if (!(kneeLocked && hipUpright)) {
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
      } else if (this._hasMoved && kneeLocked && hipUpright && isStill) {
        this._addFault('Knees re-locked before depth')
        this.state = SquatState.LOCKOUT
      }

    } else if (this.state === SquatState.DEPTH_ACHIEVED) {
      if (!atDepth) {
        const hipY = landmarks[`${side}_hip`]?.y
        this._velocityTracker.start(hipY)
        this.state = SquatState.ASCENDING
      }

    } else if (this.state === SquatState.ASCENDING) {
      const hipY = landmarks[`${side}_hip`]?.y
      this._velocityTracker.add(hipY)

      if (kneeLocked) this.state = SquatState.LOCKOUT

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
      // stay complete until manually reset
    }

    const checks = [
      { label: 'Hips upright', passed: hipUpright          },
      { label: 'Knees locked', passed: kneeLocked          },
      { label: 'Still',        passed: isStill             },
      { label: 'Depth',        passed: this._depthAchieved },
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
  constructor(onCommand, totalReps = 1, angle = 'side', stillnessFrames = 30, stillnessThreshold = 0.02) {
    this.KNEE_LOCK_ANGLE      = 160
    this.HIP_LOCK_ANGLE       = 120
    this.HINGE_HIP_ANGLE      = 130
    this.HINGE_KNEE_ANGLE     = 150
    this.SHOULDER_FORWARD_MAX = 20

    this.HAND_FOOT_SETUP_THRESHOLD  = 0.3
    this.HAND_FOOT_PULL_THRESHOLD   = 0.45
    this.FRONT_KNEE_LOCK_ANGLE      = 172

    this.LOCKOUT_HOLD_FRAMES  = 20
    this.PULL_FRAMES_REQUIRED = 4

    this.onCommand          = onCommand
    this.totalReps          = totalReps
    this.angle              = angle.toLowerCase()
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
    this._detector          = new StillnessDetector(
      [], this.stillnessFrames, this.stillnessThreshold
    )
  }

  reset() {
    this._reset()
    console.log('[RESET] Deadlift ready for next set.')
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
      console.log(`[FAULT] Rep ${this.currentRep}: ${fault}`)
    }
  }

  _giveCommand(command) {
    this.onCommand(command)
    console.log(`>>> ${command.toUpperCase()} <<<`)
  }

  _completeRep() {
    const repResult = this._faults.length === 0
      ? LiftResult.WHITE
      : LiftResult.RED

    this.repResults.push({
      rep:    this.currentRep,
      result: repResult,
      faults: repResult === LiftResult.RED ? [...this._faults] : [],
    })

    console.log(`[REP ${this.currentRep}] ${repResult}`)
  }

  _resetForNextRep() {
    this._faults          = []
    this._lockoutFrames   = 0
    this._lockoutFired    = false
    this._hipAngleHistory = []
    this._handDistHistory = []
    this._confirmedHinge  = false
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
    const dx          = shoulder.x - hip.x
    const dy          = shoulder.y - hip.y
    const torsoAngle  = Math.atan2(dx, -dy) * 180 / Math.PI
    const forwardLean = side === 'left' ? torsoAngle : -torsoAngle
    return forwardLean < this.SHOULDER_FORWARD_MAX
  }

  _isSustainedPullSide() {
    if (this._hipAngleHistory.length < this.PULL_FRAMES_REQUIRED) return false
    const recent = this._hipAngleHistory.slice(-this.PULL_FRAMES_REQUIRED)
    let risingFrames = 0
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) risingFrames++
    }
    return risingFrames >= this.PULL_FRAMES_REQUIRED - 1
  }

  _isSustainedPullFront() {
    if (this._handDistHistory.length < this.PULL_FRAMES_REQUIRED) return false
    const recent = this._handDistHistory.slice(-this.PULL_FRAMES_REQUIRED)
    let risingFrames = 0
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) risingFrames++
    }
    return risingFrames >= this.PULL_FRAMES_REQUIRED - 1
  }

  _isLockedOutFront(landmarks, angles) {
    return angles.knee >= this.FRONT_KNEE_LOCK_ANGLE
  }

  update(landmarks) {
    const side = pickBestSide(landmarks)
    if (!side) {
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

    const score    = lateralityScore(landmarks)
    const camera   = classifyCamera(score)
    const angles   = computeAngles(landmarks, side)
    const { isStill, progress } = this._updateDetector(landmarks, side)

    let kneeLocked    = false
    let hipLocked     = false
    let shouldersBack = true
    let isHinged      = false
    let sustainedPull = false
    let handDist      = 0

    if (this.angle === 'side') {
      kneeLocked    = angles.knee >= this.KNEE_LOCK_ANGLE
      hipLocked     = this._isHipLocked(landmarks, side, angles)
      shouldersBack = this._isShouldersBack(landmarks, side)
      isHinged      = angles.hip  < this.HINGE_HIP_ANGLE &&
                      angles.knee < this.HINGE_KNEE_ANGLE

      this._hipAngleHistory.push(angles.hip)
      if (this._hipAngleHistory.length > 10) this._hipAngleHistory.shift()
      sustainedPull = this._isSustainedPullSide()

    } else {
      kneeLocked = angles.knee >= this.FRONT_KNEE_LOCK_ANGLE
      hipLocked  = true

      handDist = handFootDistance(landmarks)
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
      if (isHinged) {
        this._confirmedHinge = true
      }

      if (this._confirmedHinge && sustainedPull) {
        this._hipAngleHistory = []
        this._handDistHistory = []
        this.currentRep++
        this.state = DeadliftState.PULLING
      }

      if (kneeLocked && hipLocked && !this._confirmedHinge) {
        this.state = DeadliftState.WAITING
      }

    } else if (this.state === DeadliftState.PULLING) {
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
      // stay complete until manually reset
    }

    const checks = this.angle === 'side'
      ? [
          { label: 'Knees locked',   passed: kneeLocked    },
          { label: 'Hips through',   passed: hipLocked      },
          { label: 'Shoulders back', passed: shouldersBack  },
          { label: 'Still',          passed: isStill        },
        ]
      : [
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
  constructor(onCommand, totalReps = 1, angle = 'side', calibration = null) {
    this.ELBOW_LOCK_ANGLE      = 160
    this.CHEST_RATIO_TOLERANCE = 0.06
    this.VELOCITY_THRESHOLD    = 0.004
    this.LOCKOUT_HOLD_FRAMES   = 20
    this.CHEST_HOLD_FRAMES     = 15
    this.SETUP_HOLD_FRAMES     = 25

    this.onCommand   = onCommand
    this.totalReps   = totalReps
    this.angle       = angle.toLowerCase()
    this.calibration = calibration

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

    // Do NOT clear _lockedSide here.
    // Once selected at setup, the side remains locked for the whole set.
  }

  _addFault(fault) {
    if (!this._faults.includes(fault)) {
      this._faults.push(fault)
      console.log(`[FAULT] Bench rep ${this.currentRep}: ${fault}`)
    }
  }

  _giveCommand(command) {
    this.onCommand(command)
    console.log(`>>> ${command.toUpperCase()} <<<`)
  }

  _completeRep() {
    const repResult = this._chestReached && this._faults.length === 0
      ? LiftResult.WHITE
      : LiftResult.RED

    const reasons = this._chestReached
      ? [...this._faults]
      : ['Bar did not reach chest', ...this._faults]

    this.repResults.push({
      rep:    this.currentRep,
      result: repResult,
      faults: repResult === LiftResult.RED ? reasons : [],
    })

    console.log(
      `[BENCH REP ${this.currentRep}] ${repResult}` +
      (repResult === LiftResult.RED ? ` — ${reasons.join(', ')}` : '')
    )
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
    if (this._elbowAngleHistory.length > 8) {
      this._elbowAngleHistory.shift()
    }
  }

  _elbowAtLocalMinimum() {
    const h = this._elbowAngleHistory
    if (h.length < 4) return false

    const previous = h.slice(0, -1)
    const minPrev  = Math.min(...previous)

    return h[h.length - 1] > minPrev + 3
  }

  _getSide(landmarks) {
    const detectedSide = benchPickBestSide(landmarks)

    // If side is already locked, never switch.
    if (this._lockedSide) return this._lockedSide

    return detectedSide
  }

  _lockSide(side) {
    if (!side) return

    this._lockedSide = side

    // Bench side view tracks closest-side upper + lower landmarks.
    // Lower-body landmarks are passive for now.
    if (this.angle === 'side') {
      this._trackedLandmarkKeys = getBenchSideLandmarkKeys(side)
    } else {
      // For front view, lower body should be ignored.
      // Current command logic still uses selected arm side.
      this._trackedLandmarkKeys = [
        'left_shoulder', 'left_elbow', 'left_wrist',
        'right_shoulder', 'right_elbow', 'right_wrist',
      ]
    }

    console.log(`[BenchReferee] locked side: ${side}`)
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

    // Fallback if no calibration.
    return elbowAngle < 100 && wristStill && this._elbowAtLocalMinimum()
  }

  update(landmarks, barY = null) {
    const side = this._getSide(landmarks)
    if (!side) return this._emptyReturn()

    const elbowAngle = computeElbowAngle(landmarks, side)
    if (elbowAngle === null) return this._emptyReturn()

    const wristVelocity = this._updateWristHistory(landmarks, side)
    const wristStill    = wristVelocity < this.VELOCITY_THRESHOLD
    const lockedOut     = elbowAngle >= this.ELBOW_LOCK_ANGLE

    this._updateElbowHistory(elbowAngle)

    const atChest = this._isAtChest(
      landmarks,
      side,
      elbowAngle,
      wristVelocity
    )

    // ── WAITING ─────────────────────────────────────────────────────────────
    if (this.state === BenchState.WAITING) {
      if (lockedOut) {
        this.state          = BenchState.SETUP
        this._lockoutFrames = 0
      }

    // ── SETUP ───────────────────────────────────────────────────────────────
    } else if (this.state === BenchState.SETUP) {
      if (!lockedOut) {
        this.state          = BenchState.WAITING
        this._lockoutFrames = 0
      } else if (wristStill) {
        this._lockoutFrames++

        if (this._lockoutFrames >= this.SETUP_HOLD_FRAMES) {
          // Lock the side here.
          // From now until reset, only this side affects judging/commands.
          this._lockSide(side)

          this.state              = BenchState.LOCKOUT
          this._lockoutFrames     = 0
          this._startCommandFired = false
        }
      } else {
        this._lockoutFrames = Math.max(0, this._lockoutFrames - 1)
      }

    // ── LOCKOUT ─────────────────────────────────────────────────────────────
    } else if (this.state === BenchState.LOCKOUT) {
      // If a rep has just been pressed to lockout, confirm lockout and complete it.
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
              // Stay at lockout. Wait for next START and next actual descent.
              this._resetForNextRepTop()
              this.state = BenchState.LOCKOUT
            }
          }
        } else {
          this._lockoutFrames = Math.max(0, this._lockoutFrames - 1)
        }

      // Stable top position before a rep. Give START once.
      } else if (!this._repInProgress && this.currentRep < this.totalReps) {
        if (lockedOut && wristStill && !this._startCommandFired) {
          this._lockoutFrames++

          if (this._lockoutFrames >= this.LOCKOUT_HOLD_FRAMES) {
            this._giveCommand('start')
            this._startCommandFired = true
            this._lockoutFrames     = 0
          }
        }

        // Rep starts only when the lifter actually descends.
        if (!lockedOut) {
          this.currentRep++

          this._repInProgress     = true
          this._chestReached      = false
          this._pressCommandFired = false
          this._lockoutFrames     = 0
          this._chestFrames       = 0
          this._elbowAngleHistory = []
          this._wristHistory      = []

          this.state = BenchState.DESCENDING
        }
      }

    // ── DESCENDING ──────────────────────────────────────────────────────────
    } else if (this.state === BenchState.DESCENDING) {
      if (atChest) {
        this._chestReached = true
        this._chestFrames  = 0
        this.state         = BenchState.CHEST
      }

      // If they go back to lockout without chest, complete as red.
      if (lockedOut && this._repInProgress && !this._chestReached) {
        this._addFault('Bar did not reach chest')
        this._pendingCompletion = true
        this._lockoutFrames     = 0
        this.state              = BenchState.LOCKOUT
      }

    // ── CHEST ───────────────────────────────────────────────────────────────
    } else if (this.state === BenchState.CHEST) {
      if (atChest && wristStill) {
        this._chestFrames++

        if (
          this._chestFrames >= this.CHEST_HOLD_FRAMES &&
          !this._pressCommandFired
        ) {
          this._giveCommand('press')
          this._pressCommandFired = true
        }

      } else if (!atChest && !wristStill) {
        this.state = BenchState.PRESSING
      }

    // ── PRESSING ────────────────────────────────────────────────────────────
    } else if (this.state === BenchState.PRESSING) {
      // If it drops back to chest, return to chest state.
      if (atChest) {
        this.state = BenchState.CHEST
      }

      // Rep is only completed after lockout is held.
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
    const lockedOut  = elbowAngle >= this.ELBOW_LOCK_ANGLE

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
        { label: 'Arms locked',  passed: lockedOut                 },
        { label: 'Wrist still',  passed: wristStill                },
        { label: 'Bar at chest', passed: atChest                   },
        { label: 'Calibrated',   passed: this.calibration !== null },
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