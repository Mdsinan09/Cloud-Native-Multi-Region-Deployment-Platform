import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { ArrowLeft, GitBranch, GitCommit, Clock } from 'lucide-react';

interface Deployment {
  id: string;
  app_id: string;
  commit_sha: string;
  commit_message: string | null;
  branch: string | null;
  status: string;
  image_tag: string | null;
  region: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface App {
  id: string;
  name: string;
  repo_url: string;
  namespace: string;
}

const statusColors: Record<string, string> = {
  QUEUED: 'bg-gray-100 text-gray-700',
  CLONING: 'bg-blue-100 text-blue-700',
  BUILDING: 'bg-blue-100 text-blue-700',
  PUSHING: 'bg-blue-100 text-blue-700',
  DEPLOYING: 'bg-purple-100 text-purple-700',
  HEALTH_CHECK: 'bg-yellow-100 text-yellow-700',
  SUCCESS: 'bg-green-100 text-green-700',
  HEALTH_CHECK_FAILED: 'bg-red-100 text-red-700',
  ROLLING_BACK: 'bg-orange-100 text-orange-700',
  ROLLED_BACK: 'bg-red-100 text-red-700',
};

const AppDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [app, setApp] = useState<App | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchApp();
  }, [id]);

  const fetchApp = async () => {
    try {
      const response = await api.get(`/api/apps/${id}`);
      setApp(response.data);
      setDeployments(response.data.deployments || []);
    } catch (err) {
      console.error('Failed to fetch app:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="p-8 text-center">Loading...</div>;
  if (!app) return <div className="p-8 text-center">App not found</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <button onClick={() => navigate('/apps')} className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to Apps
      </button>

      <div className="card mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{app.name}</h1>
        <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
          <span className="flex items-center gap-1">
            <GitBranch className="w-4 h-4" />
            {app.repo_url}
          </span>
          <span className="px-2 py-1 bg-gray-100 rounded text-xs font-mono">{app.namespace}</span>
        </div>
      </div>

      <h2 className="text-lg font-semibold text-gray-900 mb-4">Deployment History</h2>
      {deployments.length === 0 ? (
        <div className="card text-center py-8 text-gray-500">No deployments yet</div>
      ) : (
        <div className="space-y-3">
          {deployments.map((dep) => (
            <div
              key={dep.id}
              onClick={() => navigate(`/deployments/${dep.id}`)}
              className="card cursor-pointer hover:shadow-md transition-shadow"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <GitCommit className="w-5 h-5 text-gray-400" />
                  <div>
                    <p className="font-mono text-sm font-medium text-gray-900">
                      {dep.commit_sha.slice(0, 7)}
                    </p>
                    <p className="text-sm text-gray-500 truncate max-w-md">
                      {dep.commit_message || 'No message'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${statusColors[dep.status]}`}>
                    {dep.status.replace('_', ' ')}
                  </span>
                  <div className="text-xs text-gray-500 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(dep.created_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AppDetail;
