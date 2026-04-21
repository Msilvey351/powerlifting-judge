function StatusBar({ status }) {
  return (
    <div style={styles.container}>
      <p style={styles.text}>{status}</p>
    </div>
  )
}

const styles = {
  container: {
    padding: '16px',
    background: '#111',
    flexShrink: 0,
  },
  text: {
    fontSize: '15px',
    color: '#ccc',
    textAlign: 'center',
  }
}

export default StatusBar
