// src/logic/calibrationStore.js
const STORAGE_KEY = 'plj_calibration'

function _loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function _saveAll(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.warn('[calibrationStore] save failed:', err)
  }
}

/**
 * Get calibration for a specific lift and view.
 * e.g. getCalibration('bench', 'side')
 * Returns null if not calibrated.
 */
export function getCalibration(liftId, view) {
  return _loadAll()[liftId]?.[view.toLowerCase()] ?? null
}

/**
 * Save calibration for a specific lift and view.
 * data = { chestRatio, armExtendedDistance }
 */
export function saveCalibration(liftId, view, data) {
  const all = _loadAll()
  if (!all[liftId]) all[liftId] = {}
  all[liftId][view.toLowerCase()] = {
    ...data,
    calibratedAt: new Date().toISOString(),
  }
  _saveAll(all)
  console.log(`[calibrationStore] Saved ${liftId} ${view} calibration`)
}

/**
 * Clear calibration for a specific lift and view.
 */
export function clearCalibration(liftId, view) {
  const all = _loadAll()
  if (all[liftId]) {
    delete all[liftId][view.toLowerCase()]
    _saveAll(all)
  }
}

/**
 * Check if camera has shifted significantly since calibration.
 * Returns { shifted: bool, ratio: number }
 */
export function checkCameraShift(liftId, view, currentArmExtendedDistance) {
  const cal = getCalibration(liftId, view)
  if (!cal?.armExtendedDistance) return { shifted: false, ratio: 1 }
  const ratio = currentArmExtendedDistance / cal.armExtendedDistance
  return { shifted: ratio < 0.75 || ratio > 1.33, ratio }
}