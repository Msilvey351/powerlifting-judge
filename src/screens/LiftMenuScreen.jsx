import { useNavigate } from 'react-router-dom'
import { LIFTS } from '../models/lifts'
import LiftListItem from '../widgets/LiftListItem'

function LiftMenuScreen() {
  const navigate = useNavigate()

  const handleLiftSelect = (liftId) => {
    navigate(`/angle/${liftId}`)
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
  }
}

export default LiftMenuScreen