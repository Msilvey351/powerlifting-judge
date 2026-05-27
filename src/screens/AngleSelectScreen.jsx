// src/screens/AngleSelectScreen.jsx
import { useNavigate, useParams } from 'react-router-dom'
import { LIFTS }      from '../models/lifts'
import { initAudio }  from '../logic/audio'
import { getCalibration } from '../logic/calibrationStore'

function AngleSelectScreen() {
  const navigate    = useNavigate()
  const { liftId }  = useParams()
  const lift        = LIFTS.find(l => l.id === liftId)

  if (!lift) { navigate('/'); return null }

  const isBench = liftId === 'bench'

  const handleAngleSelect = (angle) => {
    initAudio()
    navigate(`/reps/${liftId}/${angle.toLowerCase()}`)
  }

  const handleCalibrate = (angle) => {
    initAudio()
    // Navigate to calibration with placeholder reps (1) — reps not needed for calibration
    navigate(`/calibrate/${liftId}/${angle.toLowerCase()}/1`)
  }

  const handleBack = () => navigate('/')

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button onClick={handleBack} style={styles.backButton}>← Back</button>
        <h1 style={styles.title}>{lift.name}</h1>
        <p style={styles.subtitle}>Select camera angle</p>
      </div>

      <div style={styles.list}>
        {lift.angles.map(angle => {
          const cal = isBench ? getCalibration(liftId, angle.toLowerCase()) : null
          const isCalibrated = cal !== null

          return (
            <div key={angle} style={styles.itemWrapper}>
              {/* Main angle button */}
              <button
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
                  {/* Calibration status for bench */}
                  {isBench && (
                    <p style={isCalibrated ? styles.calBadgeGreen : styles.calBadgeGrey}>
                      {isCalibrated
                        ? `✓ Calibrated (${(cal.chestRatio * 100).toFixed(1)}%)`
                        : 'Not calibrated — elbow angle only'}
                    </p>
                  )}
                </div>
                <span style={styles.arrow}>›</span>
              </button>

              {/* Calibrate button — bench only */}
              {isBench && (
                <button
                  onClick={() => handleCalibrate(angle)}
                  style={styles.calibrateBtn}
                >
                  {isCalibrated ? 'Recalibrate' : 'Calibrate'} {angle} View
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div style={styles.tip}>
        <p style={styles.tipText}>
          {isBench
            ? '💡 Calibrate once per camera position for accurate chest detection'
            : '💡 Place your phone on a stable surface at hip height'}
        </p>
      </div>
    </div>
  )
}

const styles = {
  container:      { display: 'flex', flexDirection: 'column', minHeight: '100vh', padding: '24px 16px' },
  header:         { marginBottom: '40px', marginTop: '20px' },
  backButton:     { fontSize: '16px', color: '#888', marginBottom: '16px', display: 'block', padding: '0' },
  title:          { fontSize: '28px', fontWeight: '700', marginBottom: '8px' },
  subtitle:       { fontSize: '16px', color: '#888' },
  list:           { display: 'flex', flexDirection: 'column', gap: '16px' },
  itemWrapper:    { display: 'flex', flexDirection: 'column', gap: '6px' },
  item:           { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '20px 16px', background: '#1a1a1a', borderRadius: '12px', transition: 'background 0.15s', textAlign: 'left' },
  angleName:      { fontSize: '18px', fontWeight: '500', marginBottom: '4px' },
  angleDesc:      { fontSize: '13px', color: '#888', marginBottom: '4px' },
  calBadgeGreen:  { fontSize: '12px', color: '#4CAF50', marginTop: '4px' },
  calBadgeGrey:   { fontSize: '12px', color: '#666', marginTop: '4px' },
  arrow:          { fontSize: '24px', color: '#888' },
  calibrateBtn:   { width: '100%', padding: '12px 16px', background: '#1a1a1a', color: '#888', border: '1px solid #333', borderRadius: '10px', fontSize: '14px', cursor: 'pointer', textAlign: 'center' },
  tip:            { marginTop: 'auto', paddingTop: '40px' },
  tipText:        { fontSize: '14px', color: '#666', textAlign: 'center' },
}

export default AngleSelectScreen