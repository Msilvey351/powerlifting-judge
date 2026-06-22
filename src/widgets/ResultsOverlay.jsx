import { LiftResult } from '../logic/stateMachine'

function formatVelocity(velocity) {
  if (!velocity) return null

  // Prefer estimated m/s if available.
  if (
    velocity.avgVelocityMS != null &&
    velocity.peakVelocityMS != null &&
    !Number.isNaN(velocity.avgVelocityMS) &&
    !Number.isNaN(velocity.peakVelocityMS)
  ) {
    return {
      avg:       velocity.avgVelocityMS.toFixed(2),
      peak:      velocity.peakVelocityMS.toFixed(2),
      time:      velocity.durationSec?.toFixed(2),
      unit:      'm/s',
      estimated: true,
      segment:   velocity.scaleSegment,
    }
  }

  const avg  = velocity.avgVelocityNorm
  const peak = velocity.peakVelocityNorm
  const time = velocity.durationSec

  if (
    avg == null ||
    peak == null ||
    time == null ||
    Number.isNaN(avg) ||
    Number.isNaN(peak) ||
    Number.isNaN(time)
  ) {
    return null
  }

  return {
    avg:       avg.toFixed(3),
    peak:      peak.toFixed(3),
    time:      time.toFixed(2),
    unit:      velocity.unit ?? 'norm/s',
    estimated: false,
    segment:   null,
  }
}

function ResultsOverlay({ repResults, totalReps, onDismiss }) {
  const goodReps = repResults.filter(r => r.result === LiftResult.WHITE).length

  const firstVelocity = repResults.find(r => r.velocity)?.velocity
  const lastVelocity  = [...repResults].reverse().find(r => r.velocity)?.velocity

  let firstAvg = firstVelocity?.avgVelocityMS ?? firstVelocity?.avgVelocityNorm
  let lastAvg  = lastVelocity?.avgVelocityMS  ?? lastVelocity?.avgVelocityNorm

  let velocityLoss = null
  if (firstAvg > 0 && lastAvg > 0) {
    velocityLoss = ((firstAvg - lastAvg) / firstAvg) * 100
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>

        <p style={styles.title}>SET COMPLETE</p>
        <p style={styles.subtitle}>
          {goodReps} / {totalReps} good {totalReps === 1 ? 'lift' : 'lifts'}
        </p>

        {velocityLoss !== null && !Number.isNaN(velocityLoss) && (
          <p style={styles.velocityLoss}>
            Velocity loss: {velocityLoss.toFixed(1)}%
          </p>
        )}

        <div style={styles.divider} />

        <div style={styles.repList}>
          {repResults.map((rep) => {
            const velocity = formatVelocity(rep.velocity)

            return (
              <div key={rep.rep} style={styles.repRowWrapper}>

                <div style={styles.repRow}>
                  <div style={styles.repLeft}>
                    <span style={styles.repLabel}>Rep {rep.rep}</span>

                    {rep.result === LiftResult.RED && rep.faults.length > 0 && (
                      <span style={styles.faultText}>
                        {rep.faults.join(', ')}
                      </span>
                    )}
                  </div>

                  <div style={{
                    ...styles.light,
                    background: rep.result === LiftResult.WHITE ? '#ffffff' : '#cc0000',
                    boxShadow: rep.result === LiftResult.WHITE
                      ? '0 0 12px rgba(255,255,255,0.5)'
                      : '0 0 12px rgba(204,0,0,0.5)',
                  }} />
                </div>

                {velocity && (
                  <div style={styles.velocityBox}>
                    <p style={styles.velocityLine}>
                      Avg concentric: <strong>{velocity.avg}</strong> {velocity.unit}
                      {velocity.estimated ? ' estimated' : ''}
                    </p>
                    <p style={styles.velocityLine}>
                      Peak concentric: <strong>{velocity.peak}</strong> {velocity.unit}
                      {velocity.estimated ? ' estimated' : ''}
                    </p>
                    <p style={styles.velocityLine}>
                      Time: <strong>{velocity.time}</strong>s
                    </p>
                    {velocity.estimated && velocity.segment && (
                      <p style={styles.velocitySmall}>
                        Scale from height estimate using {velocity.segment}.
                      </p>
                    )}
                  </div>
                )}

              </div>
            )
          })}
        </div>

        <div style={styles.divider} />

        <p style={styles.velocityNote}>
          Enter height in Velocity Setup to show estimated m/s. Without height, velocity uses relative screen units.
        </p>

        <button onClick={onDismiss} style={styles.doneButton}>
          Done
        </button>

      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position:       'absolute',
    top:            0,
    left:           0,
    right:          0,
    bottom:         0,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    background:     'rgba(0, 0, 0, 0.85)',
    zIndex:         10,
  },
  card: {
    background:    '#1a1a1a',
    borderRadius:  '20px',
    border:        '2px solid #333',
    padding:       '28px 32px',
    minWidth:      '280px',
    maxWidth:      '380px',
    width:         '85%',
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           '12px',
    maxHeight:     '80vh',
    overflowY:     'auto',
  },
  title: {
    fontSize:   '22px',
    fontWeight: '700',
    color:      '#fff',
    margin:     0,
    textAlign:  'center',
  },
  subtitle: {
    fontSize: '15px',
    color:    '#aaa',
    margin:   0,
  },
  velocityLoss: {
    fontSize:   '13px',
    color:      '#8bc34a',
    margin:     0,
    fontWeight: '600',
  },
  divider: {
    width:      '100%',
    height:     '1px',
    background: '#333',
    margin:     '4px 0',
  },
  repList: {
    width:         '100%',
    display:       'flex',
    flexDirection: 'column',
    gap:           '12px',
  },
  repRowWrapper: {
    width:         '100%',
    display:       'flex',
    flexDirection: 'column',
    gap:           '6px',
  },
  repRow: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    width:          '100%',
  },
  repLeft: {
    display:       'flex',
    flexDirection: 'column',
    gap:           '2px',
    flex:          1,
  },
  repLabel: {
    fontSize:   '16px',
    fontWeight: '600',
    color:      '#fff',
  },
  faultText: {
    fontSize: '12px',
    color:    '#cc0000',
  },
  light: {
    width:        '24px',
    height:       '24px',
    borderRadius: '50%',
    flexShrink:   0,
    marginLeft:   '12px',
  },
  velocityBox: {
    width:        '100%',
    boxSizing:    'border-box',
    background:   '#111',
    border:       '1px solid #2a2a2a',
    borderRadius: '8px',
    padding:      '8px 10px',
  },
  velocityLine: {
    fontSize: '12px',
    color:    '#bbb',
    margin:   '2px 0',
  },
  velocitySmall: {
    fontSize: '11px',
    color:    '#666',
    margin:   '4px 0 0',
  },
  velocityNote: {
    fontSize:   '11px',
    color:      '#666',
    textAlign:  'center',
    lineHeight: '1.4',
    margin:     0,
  },
  doneButton: {
    width:        '100%',
    padding:      '16px',
    background:   '#ffffff',
    color:        '#000000',
    fontSize:     '16px',
    fontWeight:   '700',
    borderRadius: '12px',
    border:       'none',
    cursor:       'pointer',
    marginTop:    '4px',
  }
}

export default ResultsOverlay