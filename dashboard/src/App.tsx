import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Apps from './pages/Apps'
import AppDetail from './pages/AppDetail'
import DeploymentDetail from './pages/DeploymentDetail'
import { isAuthenticated } from './api/client'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  return isAuthenticated() ? <>{children}</> : <Navigate to="/login" />
}

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/apps"
          element={
            <PrivateRoute>
              <Apps />
            </PrivateRoute>
          }
        />
        <Route
          path="/apps/:id"
          element={
            <PrivateRoute>
              <AppDetail />
            </PrivateRoute>
          }
        />
        <Route
          path="/deployments/:id"
          element={
            <PrivateRoute>
              <DeploymentDetail />
            </PrivateRoute>
          }
        />
        <Route path="/" element={<Navigate to="/apps" />} />
      </Routes>
    </div>
  )
}

export default App
