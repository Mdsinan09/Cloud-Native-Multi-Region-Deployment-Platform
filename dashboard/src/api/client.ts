import axios from 'axios'

const API_URL = '' // Uses Vite proxy

export const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle 401 responses
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export function isAuthenticated(): boolean {
  return !!localStorage.getItem('token')
}

export function logout(): void {
  localStorage.removeItem('token')
  window.location.href = '/login'
}

/* ─── Observability API ─── */

export async function getDeploymentPods(deploymentId: string, region?: string) {
  const params = region ? { region } : {}
  return api.get(`/api/observability/${deploymentId}/pods`, { params })
}

export async function getDeploymentLogs(
  deploymentId: string,
  region: string,
  options?: { tailLines?: number; previous?: boolean; container?: string }
) {
  return api.get(`/api/observability/${deploymentId}/logs`, {
    params: { region, ...options },
  })
}

export async function getPodMetrics(deploymentId: string, region: string, podName?: string) {
  return api.get(`/api/observability/${deploymentId}/metrics`, {
    params: { region, pod: podName },
  })
}

export async function getTopPods(deploymentId: string, region: string) {
  return api.get(`/api/observability/${deploymentId}/top`, {
    params: { region },
  })
}

export default api
