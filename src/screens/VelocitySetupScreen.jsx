// src/screens/VelocitySetupScreen.jsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getUserProfile, saveUserHeightCm, clearUserProfile } from '../logic/userProfileStore'

function VelocitySetupScreen() {
  const navigate = useNavigate()

  const [heightCm, setHeightCm] = useState('')
  const [savedProfile, setSavedProfile] = useState(null)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const profile = getUserProfile()
    if (profile?.heightCm) {
      setSavedProfile(profile)
      setHeightCm(String(profile.heightCm))
    }
  }, [])

  const handleChange = (e) => {
    const val = e.target.value

    if (val !== '' && !/^\d+$/.test(val)) return

    setHeightCm(val)
    setError(null)
    setSaved(false)
  }

  const handleSave = () => {
    try {
      const profile = saveUserHeightCm(heightCm)
      setSavedProfile(profile)
      setSaved(true)
      setError(null)
    } catch (err) {
      setError(err.message)
      setSaved(false)
    }
  }

  const handleClear = () => {
    clearUserProfile()
    setSavedProfile(null)
    setHeightCm('')
    setSaved(false)
    setError(null)
  }

  const handleBack = () => {
    navigate('/')
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button onClick={handleBack} style={styles.backButton}>
          ← Back
        </button>

        <h1 style={styles.title}>Velocity Setup</h1>
        <p style={styles.subtitle}>
          Enter your height once to estimate real-world bar speed in m/s.
        </p>
      </div>

      <div style={styles.card}>
        {savedProfile && (
          <div style={styles.currentBox}>
            <p style={styles.currentLabel}>Current saved height</p>
            <p style={styles.currentValue}>{savedProfile.heightCm} cm</p>
          </div>
        )}

        <label style={styles.label}>Height</label>

        <div style={styles.inputRow}>
          <input
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            value={heightCm}
            onChange={handleChange}
            placeholder="180"
            style={styles.input}
          />
          <span style={styles.unit}>cm</span>
        </div>

        {error && (
          <p style={styles.errorText}>{error}</p>
        )}

        {saved && (
          <p style={styles.savedText}>✓ Saved</p>
        )}

        <button onClick={handleSave} style={styles.saveButton}>
          Save Height
        </button>

        {savedProfile && (
          <button onClick={handleClear} style={styles.clearButton}>
            Clear Height
          </button>
        )}
      </div>

      <div style={styles.info}>
        <p style={styles.infoText}>
          Velocity will be shown as estimated m/s when height is saved.
          Without height, results use relative screen units.
        </p>
        <p style={styles.infoText}>
          This is an estimate based on body segment proportions. For lab-grade accuracy,
          future plate calibration can improve precision.
        </p>
      </div>
    </div>
  )
}

const styles = {
  container: {
    display:       'flex',
    flexDirection: 'column',
    minHeight:     '100vh',
    padding:       '24px 16px',
  },
  header: {
    marginBottom: '32px',
    marginTop:    '20px',
  },
  backButton: {
    fontSize:     '16px',
    color:        '#888',
    marginBottom: '16px',
    display:      'block',
    padding:      '0',
  },
  title: {
    fontSize:     '28px',
    fontWeight:   '700',
    marginBottom: '8px',
  },
  subtitle: {
    fontSize:   '15px',
    color:      '#888',
    lineHeight: '1.4',
  },
  card: {
    background:    '#1a1a1a',
    border:        '1px solid #333',
    borderRadius:  '16px',
    padding:       '20px',
    display:       'flex',
    flexDirection: 'column',
    gap:           '12px',
  },
  currentBox: {
    background:    '#111',
    border:        '1px solid #2a2a2a',
    borderRadius:  '12px',
    padding:       '14px',
    marginBottom:  '8px',
  },
  currentLabel: {
    color:      '#888',
    fontSize:   '12px',
    margin:     0,
  },
  currentValue: {
    color:      '#fff',
    fontSize:   '22px',
    fontWeight: '700',
    margin:     '4px 0 0',
  },
  label: {
    fontSize:   '13px',
    color:      '#888',
    fontWeight: '600',
  },
  inputRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        '12px',
  },
  input: {
    flex:         1,
    padding:      '16px',
    fontSize:     '28px',
    fontWeight:   '700',
    textAlign:    'center',
    background:   '#111',
    border:       '2px solid #333',
    borderRadius: '12px',
    color:        '#fff',
    outline:      'none',
  },
  unit: {
    fontSize:   '18px',
    color:      '#aaa',
    fontWeight: '600',
  },
  errorText: {
    color:    '#cc0000',
    fontSize: '13px',
    margin:   0,
  },
  savedText: {
    color:    '#4CAF50',
    fontSize: '13px',
    margin:   0,
  },
  saveButton: {
    width:        '100%',
    padding:      '16px',
    background:   '#fff',
    color:        '#000',
    border:       'none',
    borderRadius: '12px',
    fontSize:     '16px',
    fontWeight:   '700',
    cursor:       'pointer',
    marginTop:    '8px',
  },
  clearButton: {
    width:        '100%',
    padding:      '12px',
    background:   'transparent',
    color:        '#777',
    border:       '1px solid #333',
    borderRadius: '12px',
    fontSize:     '14px',
    cursor:       'pointer',
  },
  info: {
    marginTop: '24px',
  },
  infoText: {
    color:      '#666',
    fontSize:   '13px',
    lineHeight: '1.5',
  },
}

export default VelocitySetupScreen