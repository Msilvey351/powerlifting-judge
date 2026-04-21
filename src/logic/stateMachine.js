import { computeAngles, checkDepth, pickBestSide,
         lateralityScore, classifyCamera,
         handFootDistance } from './poseUtils.js'

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
    })

    console.log(`[REP ${this.currentRep}] ${repResult}${repResult === LiftResult.RED ? ' — ' + reasons.join(', ') : ''}`)
  }

  _resetForNextRep() {
    this._depthAchieved  = false
    this._hasMoved       = false
    this._faults         = []
    this._setupEntryTime = null
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
      if (!atDepth) this.state = SquatState.ASCENDING

    } else if (this.state === SquatState.ASCENDING) {
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
    // ── Side view thresholds ────────────────────────────────────────────────
    this.KNEE_LOCK_ANGLE      = 160
    this.HIP_LOCK_ANGLE       = 120
    this.HINGE_HIP_ANGLE      = 130
    this.HINGE_KNEE_ANGLE     = 150
    this.SHOULDER_FORWARD_MAX = 20

    // ── Front view thresholds ───────────────────────────────────────────────
    // hand to foot distance (normalised 0-1)
    // when hands are near floor, this value is small
    this.HAND_FOOT_SETUP_THRESHOLD  = 0.3   // hands this close to feet = setup position
    this.HAND_FOOT_PULL_THRESHOLD   = 0.45  // hands risen this far = pulling
    this.FRONT_KNEE_LOCK_ANGLE      = 172   // knee angle for front view lockout

    // ── Shared thresholds ───────────────────────────────────────────────────
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

  // ── Side view helpers ───────────────────────────────────────────────────────

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

  // ── Front view helpers ──────────────────────────────────────────────────────

  _isSustainedPullFront() {
    // detect pull by hands rising away from feet
    // hand-foot distance increasing = hands rising = pulling
    if (this._handDistHistory.length < this.PULL_FRAMES_REQUIRED) return false
    const recent = this._handDistHistory.slice(-this.PULL_FRAMES_REQUIRED)
    let risingFrames = 0
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) risingFrames++
    }
    return risingFrames >= this.PULL_FRAMES_REQUIRED - 1
  }

  _isLockedOutFront(landmarks, angles) {
    // front view lockout — knees locked only
    // hip check not reliable from front
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

    // ── Per-angle checks ──────────────────────────────────────────────────
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
      // front view
      kneeLocked = angles.knee >= this.FRONT_KNEE_LOCK_ANGLE
      hipLocked  = true  // not checked from front — knees only

      handDist = handFootDistance(landmarks)
      this._handDistHistory.push(handDist)
      if (this._handDistHistory.length > 10) this._handDistHistory.shift()

      // hinged = hands close to feet
      isHinged      = handDist < this.HAND_FOOT_SETUP_THRESHOLD
      sustainedPull = this._isSustainedPullFront()
    }

    // ── State transitions ─────────────────────────────────────────────────
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

    // checklist per angle
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
