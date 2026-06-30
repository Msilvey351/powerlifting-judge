import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LiftMenuScreen      from './screens/LiftMenuScreen'
import AngleSelectScreen   from './screens/AngleSelectScreen'
import RepSelectScreen     from './screens/RepSelectScreen'
import CalibrationScreen   from './screens/CalibrationScreen'
import VelocitySetupScreen from './screens/VelocitySetupScreen'
import CameraScreen        from './screens/CameraScreen'
import VideoAnalysisScreen from './screens/VideoAnalysisScreen'
import './index.css'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"                               element={<LiftMenuScreen />}      />
        <Route path="/velocity-setup"                 element={<VelocitySetupScreen />} />
        <Route path="/video-analysis"                 element={<VideoAnalysisScreen />} />
        <Route path="/angle/:liftId"                  element={<AngleSelectScreen />}   />
        <Route path="/reps/:liftId/:angle"            element={<RepSelectScreen />}     />
        <Route path="/calibrate/:liftId/:angle/:reps" element={<CalibrationScreen />}   />
        <Route path="/camera/:liftId/:angle/:reps"    element={<CameraScreen />}        />
        <Route path="*"                               element={<Navigate to="/" />}     />
      </Routes>
    </BrowserRouter>
  )
}

export default App