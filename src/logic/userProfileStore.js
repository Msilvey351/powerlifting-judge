// src/logic/userProfileStore.js

const STORAGE_KEY = 'plj_user_profile'

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function _save(profile) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
}

export function getUserProfile() {
  return _load()
}

export function saveUserHeightCm(heightCm) {
  const numeric = Number(heightCm)

  if (!numeric || Number.isNaN(numeric)) {
    throw new Error('Invalid height')
  }

  if (numeric < 100 || numeric > 250) {
    throw new Error('Height must be between 100cm and 250cm')
  }

  const profile = {
    heightCm: numeric,
    heightM: numeric / 100,
    updatedAt: new Date().toISOString(),
  }

  _save(profile)
  return profile
}

export function clearUserProfile() {
  localStorage.removeItem(STORAGE_KEY)
}