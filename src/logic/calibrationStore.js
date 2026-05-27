// src/logic/calibrationStore.js
const STORAGE_KEY = 'plj_profiles'

function _loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function _saveAll(profiles) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
  } catch (err) {
    console.warn('[calibrationStore] save failed:', err)
  }
}

export function listProfiles() {
  return Object.keys(_loadAll()).sort()
}

export function getProfile(name) {
  return _loadAll()[name] ?? null
}

export function getBenchCalibration(name) {
  return getProfile(name)?.bench ?? null
}

export function saveBenchCalibration(name, calibration) {
  const profiles  = _loadAll()
  const existing  = profiles[name] ?? { name }
  profiles[name]  = {
    ...existing,
    bench: { ...calibration, calibratedAt: new Date().toISOString() }
  }
  _saveAll(profiles)
  console.log(`[calibrationStore] Saved bench calibration for "${name}"`)
}

export function deleteProfile(name) {
  const profiles = _loadAll()
  delete profiles[name]
  _saveAll(profiles)
}

export function checkCameraShift(name, currentArmExtendedDistance) {
  const cal = getBenchCalibration(name)
  if (!cal?.armExtendedDistance) return { shifted: false, ratio: 1 }
  const ratio = currentArmExtendedDistance / cal.armExtendedDistance
  return { shifted: ratio < 0.75 || ratio > 1.33, ratio }
}