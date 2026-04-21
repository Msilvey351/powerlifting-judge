import { LiftResult } from '../logic/stateMachine'

function ResultsOverlay({ repResults, totalReps, onDismiss }) {
  const goodReps = repResults.filter(r => r.result === LiftResult.WHITE).length

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>

        {/* Header */}
        <p style={styles.title}>SET COMPLETE</p>
        <p style={styles.subtitle}>
          {goodReps} / {totalReps} good {totalReps === 1 ? 'lift' : 'lifts'}
        </p>

        <div style={styles.divider} />

        {/* Rep list */}
        <div style={styles.repList}>
          {repResults.map((rep) => (
            <div key={rep.rep} style={styles.repRow}>

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
          ))}
        </div>

        <div style={styles.divider} />

        {/* Done button */}
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
    maxWidth:      '340px',
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
    gap:           '10px',
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
