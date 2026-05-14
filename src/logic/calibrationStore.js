// src/logic/calibrationStore.js
//
// Local profile storage for bench press calibration.
// Uses localStorage — no login, no server, persists across sessions.
//
// Schema stored at key 'plj_profiles':
// {
//   "Alex": {
//     name: "Alex",
//     bench: {
//       chestRatio:          0.71,   // arm_bent / arm_extended at chest
//       armExtendedDistance: 0.38,   // reference arm length (normalised image coords)
//       side:                "right", // which side was used for calibration
//       calibratedAt:        "2026-05-14T20:25:00"
//     }
//   },
//   ...
// }

const STORAGE_KEY = 'plj_profiles'

// ── Read all profiles ─────────────────────────────────────────────────────────
function _loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

// ── Write all profiles ────────────────────────────────────────────────────────
function _saveAll(profiles) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
  } catch (err) {
    console.warn('[calibrationStore] save failed:', err)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a sorted array of profile names.
 */
export function listProfiles() {
  return Object.keys(_loadAll()).sort()
}

/**
 * Returns the full profile object for a name, or null if not found.
 */
export function getProfile(name) {
  return _loadAll()[name] ?? null
}

/**
 * Returns the bench calibration for a profile, or null if not calibrated.
 */
export function getBenchCalibration(name) {
  return getProfile(name)?.bench ?? null
}

/**
 * Save a bench calibration for a lifter.
 * Creates the profile if it doesn't exist.
 *
 * calibration = {
 *   chestRatio:          number,
 *   armExtendedDistance: number,
 *   side:                'left' | 'right',
 * }
 */
export function saveBenchCalibration(name, calibration) {
  const profiles      = _loadAll()
  const existing      = profiles[name] ?? { name }
  profiles[name]      = {
    ...existing,
    bench: {
      ...calibration,
      calibratedAt: new Date().toISOString(),
    }
  }
  _saveAll(profiles)
  console.log(`[calibrationStore] Saved bench calibration for "${name}"`)
}

/**
 * Delete a profile entirely.
 */
export function deleteProfile(name) {
  const profiles = _loadAll()
  delete profiles[name]
  _saveAll(profiles)
}

/**
 * Check whether the camera position has shifted significantly since calibration.
 * Compares current arm extended distance against stored reference.
 * Returns { shifted: bool, ratio: number }
 */
export function checkCameraShift(name, currentArmExtendedDistance) {
  const cal = getBenchCalibration(name)
  if (!cal || !cal.armExtendedDistance) return { shifted: false, ratio: 1 }

  const ratio = currentArmExtendedDistance / cal.armExtendedDistance
  return {
    shifted: ratio < 0.75 || ratio > 1.33,
    ratio:   ratio,
  }
}