function LiftListItem({ lift, onSelect }) {
  return (
    <button
      onClick={onSelect}
      style={styles.item}
      onMouseEnter={e => e.currentTarget.style.background = '#2a2a2a'}
      onMouseLeave={e => e.currentTarget.style.background = '#1a1a1a'}
    >
      <span style={styles.name}>{lift.name}</span>
      <span style={styles.arrow}>›</span>
    </button>
  )
}

const styles = {
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
  name: {
    fontSize: '18px',
    fontWeight: '500',
  },
  arrow: {
    fontSize: '24px',
    color: '#888',
  }
}

export default LiftListItem
