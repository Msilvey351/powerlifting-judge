import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

function RepSelectScreen() {
  const navigate = useNavigate()
  const { liftId, angle } = useParams()
  const [reps, setReps] = useState('')
  const [error, setError] = useState(null)

  const formatParam = (str) => str.charAt(0).toUpperCase() + str.slice(1)

  const handleChange = (e) => {
    const val = e.target.value

    // only allow digits
    if (val !== '' && !/^\d+$/.test(val)) return

    setReps(val)
    setError(null)
  }

  const handleStart = () => {
    const num = parseInt(reps, 10)

    if (!reps || isNaN(num)) {
      setError('Please enter a number')
      return
    }
    if (num < 1 || num > 15) {
      setError('Please enter a number between 1 and 15')
      return
    }

    navigate(`/camera/${liftId}/${angle}/${num}`)
  }

  const handleBack = () => {
    navigate(`/angle/${liftId}`)
  }

  // allow pressing Enter to start
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleStart()
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button onClick={handleBack} style={styles.backButton}>
          ← Back
        </button>
        <h1 style={styles.title}>
          {formatParam(liftId)} | {formatParam(angle)}
        </h1>
        <p style={styles.subtitle}>How many reps?</p>
      </div>

      <div style={styles.inputSection}>
        <input
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          min="1"
          max="15"
          value={reps}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Enter reps"
          style={styles.input}
          autoFocus
        />
        {error && (
          <p style={styles.errorText}>{error}</p>
        )}
        <p style={styles.hint}>1 – 15 reps</p>
      </div>

      <button
        onClick={handleStart}
        style={{
          ...styles.startButton,
          opacity: reps ? 1 : 0.4,
        }}
      >
        Start
      </button>
    </div>
  )
}

const styles = {
  container: {
    display:        'flex',
    flexDirection:  'column',
    minHeight:      '100vh',
    padding:        '24px 16px',
  },
  header: {
    marginBottom: '40px',
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
    fontSize: '16px',
    color:    '#888',
  },
  inputSection: {
    flex:           1,
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '12px',
  },
  input: {
    width:        '100%',
    maxWidth:     '200px',
    padding:      '16px',
    fontSize:     '32px',
    fontWeight:   '700',
    textAlign:    'center',
    background:   '#1a1a1a',
    border:       '2px solid #333',
    borderRadius: '12px',
    color:        '#fff',
    outline:      'none',
    // hide number input arrows
    MozAppearance:    'textfield',
  },
  errorText: {
    color:     '#cc0000',
    fontSize:  '14px',
    textAlign: 'center',
    margin:    0,
  },
  hint: {
    color:    '#666',
    fontSize: '13px',
    margin:   0,
  },
  startButton: {
    width:          '100%',
    padding:        '18px',
    background:     '#ffffff',
    color:          '#000000',
    fontSize:       '18px',
    fontWeight:     '700',
    borderRadius:   '12px',
    border:         'none',
    cursor:         'pointer',
    transition:     'opacity 0.2s',
  }
}

export default RepSelectScreen
