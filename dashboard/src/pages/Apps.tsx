import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, logout } from '../api/client';
import { Plus, LogOut, ExternalLink } from 'lucide-react';

interface App {
  id: string;
  name: string;
  repo_url: string;
  namespace: string;
  created_at: string;
}

const Apps: React.FC = () => {
  const navigate = useNavigate();
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newApp, setNewApp] = useState({ name: '', repoUrl: '', githubWebhookSecret: '', namespace: 'default' });

  useEffect(() => {
    fetchApps();
  }, []);

  const fetchApps = async () => {
    try {
      const response = await api.get('/api/apps');
      setApps(response.data);
    } catch (err) {
      console.error('Failed to fetch apps:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/apps', newApp);
      setShowModal(false);
      setNewApp({ name: '', repoUrl: '', githubWebhookSecret: '', namespace: 'default' });
      fetchApps();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to create app');
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Applications</h1>
          <p className="text-gray-500 mt-1">Manage your deployed applications</p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New App
          </button>
          <button onClick={logout} className="btn-secondary flex items-center gap-2">
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : apps.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No applications yet. Create your first app to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {apps.map((app) => (
            <div
              key={app.id}
              onClick={() => navigate(`/apps/${app.id}`)}
              className="card cursor-pointer hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-lg text-gray-900">{app.name}</h3>
                  <p className="text-sm text-gray-500 mt-1">{app.namespace}</p>
                </div>
                <ExternalLink className="w-4 h-4 text-gray-400" />
              </div>
              <p className="text-sm text-gray-600 mt-3 truncate font-mono">{app.repo_url}</p>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 m-4">
            <h2 className="text-xl font-bold mb-4">Create New App</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">App Name</label>
                <input
                  required
                  className="input"
                  value={newApp.name}
                  onChange={(e) => setNewApp({ ...newApp, name: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Repository URL</label>
                <input
                  required
                  type="url"
                  placeholder="https://github.com/user/repo.git"
                  className="input"
                  value={newApp.repoUrl}
                  onChange={(e) => setNewApp({ ...newApp, repoUrl: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Namespace</label>
                <input
                  className="input"
                  value={newApp.namespace}
                  onChange={(e) => setNewApp({ ...newApp, namespace: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Webhook Secret (optional)</label>
                <input
                  type="password"
                  className="input"
                  value={newApp.githubWebhookSecret}
                  onChange={(e) => setNewApp({ ...newApp, githubWebhookSecret: e.target.value })}
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary flex-1">
                  Cancel
                </button>
                <button type="submit" className="btn-primary flex-1">
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Apps;
