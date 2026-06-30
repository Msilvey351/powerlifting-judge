import { useNavigate } from 'react-router-dom'
import { LIFTS } from '../models/lifts'
import LiftListItem from '../widgets/LiftListItem'
import { getUserProfile } from '../logic/userProfileStore'

function LiftMenuScreen() {
  const navigate = useNavigate()
  const profile  = getUserProfile()

  const handleLiftSelect = (liftId) => {
    navigate(`/angle/${liftId}`)
  }

  const handleVelocitySetup = () => {
    navigate('/velocity-setup')
  }

  const handleVideoAnalysis = () => {
    navigate('/video-analysis')
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Powerlifting Judge</h1>
        <p style={styles.subtitle}>Select a lift to begin</p>
      </div>

      <div style={styles.list}>
        {LIFTS.map(lift => (
          <LiftListItem
            key={lift.id}
            lift={lift}
            onSelect={() => handleLiftSelect(lift.id)}
          />
        ))}

        <button
          onClick={handleVelocitySetup}
          style={styles.secondaryButton}
          onMouseEnter={e => e.currentTarget.style.background = '#2a2a2a'}
          onMouseLeave={e => e.currentTarget.style.background = '#1a1a1a'}
        >
          <div>
            <p style={styles.secondaryTitle}>Velocity Setup</p>
            <p style={styles.secondarySubtitle}>
              {profile?.heightCm
                ? `Height saved: ${profile.heightCm} cm — estimated m/s enabled`
                : 'Enter height to estimate velocity in m/s'}
            </p>
          </div>
          <span style={styles.arrow}>›</span>
        </button>

        <button
          onClick={handleVideoAnalysis}
          style={{
            ...styles.secondaryButton,
            border: '1px solid #2a2a2a',
          }}
          onMouseEnter={e => e.currentTarget.style.background = '#2a2a2a'}
          onMouseLeave={e => e.currentTarget.style.background = '#1a1a1a'}
        >
          <div>
            <p style={styles.secondaryTitle}>Video Analysis</p>
            <p style={styles.secondarySubtitle}>
              Upload a video to judge — dev tool
            </p>
          </div>
          <span style={styles.arrow}>›</span>
        </button>
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
    marginBottom: '40px',
    marginTop:    '20px',
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
  list: {
    display:       'flex',
    flexDirection: 'column',
    gap:           '12px',
  },
  secondaryButton: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    width:          '100%',
    padding:        '20px 16px',
    background:     '#1a1a1a',
    borderRadius:   '12px',
    border:         '1px solid #333',
    transition:     'background 0.15s',
    textAlign:      'left',
    cursor:         'pointer',
  },
  secondaryTitle: {
    fontSize:     '18px',
    fontWeight:   '500',
    marginBottom: '4px',
    color:        '#fff',
  },
  secondarySubtitle: {
    fontSize: '13px',
    color:    '#888',
  },
  arrow: {
    fontSize: '24px',
    color:    '#888',
  },
}

export default LiftMenuScreen