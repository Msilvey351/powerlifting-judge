import { useNavigate, useParams } from 'react-router-dom'
import { LIFTS } from '../models/lifts'
import { initAudio } from '../logic/audio'


function AngleSelectScreen() {
  const navigate = useNavigate()
  const { liftId } = useParams()

  // find the lift object that matches the URL
  const lift = LIFTS.find(l => l.id === liftId)

  // if somehow an invalid liftId is in the URL, go back to menu
  if (!lift) {
    navigate('/')
    return null
  }

  const handleAngleSelect = (angle) => {
    initAudio()
    navigate(`/reps/${liftId}/${angle.toLowerCase()}`)
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
        <h1 style={styles.title}>{lift.name}</h1>
        <p style={styles.subtitle}>Select camera angle</p>
      </div>

      <div style={styles.list}>
        {lift.angles.map(angle => (
          <button
            key={angle}
            onClick={() => handleAngleSelect(angle)}
            style={styles.item}
            onMouseEnter={e => e.currentTarget.style.background = '#2a2a2a'}
            onMouseLeave={e => e.currentTarget.style.background = '#1a1a1a'}
          >
            <div>
              <p style={styles.angleName}>{angle} View</p>
              <p style={styles.angleDesc}>
                {angle === 'Side'
                  ? 'Position camera directly to your side'
                  : 'Position camera directly in front of you'}
              </p>
            </div>
            <span style={styles.arrow}>›</span>
          </button>
        ))}
      </div>

      <div style={styles.tip}>
        <p style={styles.tipText}>
          💡 Place your phone on a stable surface at hip height
        </p>
      </div>
    </div>
  )
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    padding: '24px 16px',
  },
  header: {
    marginBottom: '40px',
    marginTop: '20px',
  },
  backButton: {
    fontSize: '16px',
    color: '#888',
    marginBottom: '16px',
    display: 'block',
    padding: '0',
  },
  title: {
    fontSize: '28px',
    fontWeight: '700',
    marginBottom: '8px',
  },
  subtitle: {
    fontSize: '16px',
    color: '#888',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: '20px 16px',
    background: '#1a1a1a',
    borderRadius: '12px',
    transition: 'background 0.15s',
    textAlign: 'left',
  },
  angleName: {
    fontSize: '18px',
    fontWeight: '500',
    marginBottom: '4px',
  },
  angleDesc: {
    fontSize: '13px',
    color: '#888',
  },
  arrow: {
    fontSize: '24px',
    color: '#888',
  },
  tip: {
    marginTop: 'auto',
    paddingTop: '40px',
  },
  tipText: {
    fontSize: '14px',
    color: '#666',
    textAlign: 'center',
  }
}

export default AngleSelectScreen