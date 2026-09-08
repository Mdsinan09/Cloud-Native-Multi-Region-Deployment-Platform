import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import StateMachine from '../components/StateMachine';
import DeploymentTimeline from '../components/DeploymentTimeline';
import RegionCard from '../components/RegionCard';
import PodTable from '../components/PodTable';
import LogViewer from '../components/LogViewer';

interface Deployment {
  id: string;
  app_id: string;
  commit_sha: string;
  commit_message: string | null;
  status: string;
  image_tag: string | null;
  region: string;
  created_at: string;
}

interface Event {
  id: string;
  event: string;
  message: string | null;
  created_at: string;
}

interface SubDeployment {
  id: string;
  region: string;
  status: string;
  ingress_host: string | null;
  health_check_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

const DeploymentDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [subDeployments, setSubDeployments] = useState<SubDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [rollingBack, setRollingBack] = useState(false);

  // Log viewer state
  const [logViewer, setLogViewer] = useState<{
    open: boolean;
    podName: string;
    region: string;
  }>({ open: false, podName: '', region: '' });

  useEffect(() => {
    fetchDeployment();
    const interval = setInterval(fetchDeployment, 3000);
    return () => clearInterval(interval);
  }, [id]);

  // ESC key to close log viewer
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLogViewer((prev) => ({ ...prev, open: false }));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const fetchDeployment = async () => {
    try {
      const response = await api.get(`/api/deployments/${id}`);
      setDeployment(response.data);
      setEvents(response.data.events || []);
      setSubDeployments(response.data.subDeployments || []);
    } catch (err) {
      console.error('Failed to fetch deployment:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRollback = async () => {
    if (!window.confirm('Are you sure you want to rollback this deployment?')) return;
    setRollingBack(true);
    try {
      await api.post(`/api/deployments/${id}/rollback`);
      fetchDeployment();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Rollback failed');
    } finally {
      setRollingBack(false);
    }
  };

  const handleViewLogs = (podName: string, region: string) => {
    setLogViewer({ open: true, podName, region });
  };

  const canRollback = ['SUCCESS', 'HEALTH_CHECK_FAILED'].includes(deployment?.status || '');

  if (loading) return <div className="p-8 text-center">Loading...</div>;
  if (!deployment) return <div className="p-8 text-center">Deployment not found</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <button
        onClick={() => navigate(`/apps/${deployment.app_id}`)}
        className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to App
      </button>

      {/* Deployment Header + State Machine */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Deployment</h1>
            <p className="text-sm text-gray-500 font-mono mt-1">{deployment.commit_sha}</p>
          </div>
          {canRollback && (
            <button
              onClick={handleRollback}
              disabled={rollingBack}
              className="btn-danger flex items-center gap-2 disabled:opacity-50"
            >
              <RotateCcw className="w-4 h-4" />
              {rollingBack ? 'Rolling back...' : 'Rollback'}
            </button>
          )}
        </div>
        <StateMachine status={deployment.status} />
      </div>

      {/* Region Cards */}
      {subDeployments.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {subDeployments.map((sub) => (
            <RegionCard key={sub.id} subDeployment={sub} />
          ))}
        </div>
      )}

      {/* Live Pods Table */}
      {['DEPLOYING', 'HEALTH_CHECK', 'SUCCESS', 'HEALTH_CHECK_FAILED', 'ROLLING_BACK', 'ROLLED_BACK'].includes(deployment.status) && (
        <div className="mb-6">
          <PodTable deploymentId={deployment.id} onViewLogs={handleViewLogs} />
        </div>
      )}

      {/* Event Timeline */}
      <div className="card">
        <DeploymentTimeline events={events} />
      </div>

      {/* Log Viewer Modal */}
      {logViewer.open && (
        <LogViewer
          deploymentId={deployment.id}
          podName={logViewer.podName}
          region={logViewer.region}
          onClose={() => setLogViewer({ open: false, podName: '', region: '' })}
        />
      )}
    </div>
  );
};

export default DeploymentDetail;
