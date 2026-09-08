import React, { useState, useEffect } from 'react';
import { getDeploymentPods, getTopPods } from '../api/client';
import { Server, Clock, RefreshCw, FileText, BarChart3 } from 'lucide-react';

interface PodContainer {
  name: string;
  ready: boolean;
  restartCount: number;
  state: string;
  reason?: string;
  message?: string;
}

interface PodInfo {
  name: string;
  status: string;
  restarts: number;
  ready: string;
  age: string;
  node: string;
  containers: PodContainer[];
}

interface PodTableProps {
  deploymentId: string;
  onViewLogs: (podName: string, region: string) => void;
}

const statusColors: Record<string, string> = {
  Running: 'bg-green-100 text-green-800 border-green-200',
  Pending: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  Succeeded: 'bg-blue-100 text-blue-800 border-blue-200',
  Failed: 'bg-red-100 text-red-800 border-red-200',
  Unknown: 'bg-gray-100 text-gray-800 border-gray-200',
  CrashLoopBackOff: 'bg-red-100 text-red-800 border-red-200 animate-pulse',
  ImagePullBackOff: 'bg-orange-100 text-orange-800 border-orange-200',
  ErrImagePull: 'bg-orange-100 text-orange-800 border-orange-200',
  Error: 'bg-red-100 text-red-800 border-red-200',
  Completed: 'bg-blue-100 text-blue-800 border-blue-200',
  ContainerCreating: 'bg-yellow-100 text-yellow-800 border-yellow-200',
};

const containerStateColors: Record<string, string> = {
  running: 'text-green-600',
  waiting: 'text-yellow-600',
  terminated: 'text-red-600',
  unknown: 'text-gray-500',
};

const PodTable: React.FC<PodTableProps> = ({ deploymentId, onViewLogs }) => {
  const [regions, setRegions] = useState<Array<{ region: string; pods: PodInfo[]; error: string | null }>>([]);
  const [activeRegion, setActiveRegion] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [topData, setTopData] = useState<Record<string, { cpu: string; memory: string }>>({});

  const fetchPods = async () => {
    setLoading(true);
    try {
      const response = await getDeploymentPods(deploymentId);
      const data = response.data;
      setRegions(data.regions || []);
      if (data.regions?.length > 0 && !activeRegion) {
        setActiveRegion(data.regions[0].region);
      }

      // Fetch metrics for each region
      for (const r of data.regions || []) {
        if (r.pods.length > 0) {
          try {
            const topRes = await getTopPods(deploymentId, r.region);
            const topMap: Record<string, { cpu: string; memory: string }> = {};
            for (const p of topRes.data.pods || []) {
              topMap[p.name] = p;
            }
            setTopData((prev) => ({ ...prev, ...topMap }));
          } catch {
            // metrics-server may not be available
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch pods:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPods();
    const interval = setInterval(fetchPods, 5000);
    return () => clearInterval(interval);
  }, [deploymentId]);

  const activePods = regions.find((r) => r.region === activeRegion)?.pods || [];
  const activeError = regions.find((r) => r.region === activeRegion)?.error;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Server className="w-5 h-5 text-gray-600" />
          <h3 className="text-lg font-semibold text-gray-900">Live Pods</h3>
        </div>
        <button onClick={fetchPods} className="btn-secondary flex items-center gap-1 text-sm py-1 px-2">
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {/* Region Tabs */}
      <div className="flex gap-2 mb-4 border-b border-gray-200">
        {regions.map((r) => (
          <button
            key={r.region}
            onClick={() => setActiveRegion(r.region)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeRegion === r.region
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {r.region}
            {r.pods.length > 0 && (
              <span className="ml-2 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">
                {r.pods.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && regions.length === 0 ? (
        <div className="text-center py-8 text-gray-500">Loading pods...</div>
      ) : activeError ? (
        <div className="text-center py-8 text-red-500">{activeError}</div>
      ) : activePods.length === 0 ? (
        <div className="text-center py-8 text-gray-500">No pods found in {activeRegion}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="pb-2 font-medium">Pod Name</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Ready</th>
                <th className="pb-2 font-medium">Restarts</th>
                <th className="pb-2 font-medium">Age</th>
                <th className="pb-2 font-medium">Node</th>
                <th className="pb-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {activePods.map((pod) => (
                <tr key={pod.name} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="py-3 font-mono text-xs text-gray-900">{pod.name}</td>
                  <td className="py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${statusColors[pod.status] || statusColors.Unknown}`}>
                      {pod.status}
                    </span>
                  </td>
                  <td className="py-3 text-gray-700">{pod.ready}</td>
                  <td className="py-3">
                    <span className={pod.restarts > 0 ? 'text-red-600 font-medium' : 'text-gray-600'}>
                      {pod.restarts}
                    </span>
                  </td>
                  <td className="py-3 text-gray-500 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {pod.age}
                  </td>
                  <td className="py-3 text-gray-500 text-xs">{pod.node}</td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => onViewLogs(pod.name, activeRegion)}
                        className="flex items-center gap-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded transition-colors"
                      >
                        <FileText className="w-3 h-3" />
                        Logs
                      </button>
                      {topData[pod.name] && (
                        <div className="flex items-center gap-1 text-xs text-gray-600 bg-gray-50 px-2 py-1 rounded">
                          <BarChart3 className="w-3 h-3" />
                          {topData[pod.name].cpu} / {topData[pod.name].memory}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Container Details */}
          {activePods.map((pod) =>
            pod.containers.length > 1 || pod.containers.some((c) => c.reason) ? (
              <div key={`${pod.name}-containers`} className="mt-2 ml-4 p-2 bg-gray-50 rounded text-xs">
                <p className="font-medium text-gray-700 mb-1">Containers:</p>
                {pod.containers.map((c) => (
                  <div key={c.name} className="flex items-center gap-2 py-0.5">
                    <span className="font-mono text-gray-600">{c.name}</span>
                    <span className={`${containerStateColors[c.state] || containerStateColors.unknown}`}>
                      {c.state}
                    </span>
                    {c.reason && <span className="text-red-600">({c.reason})</span>}
                    {c.message && <span className="text-gray-500 truncate max-w-xs">{c.message}</span>}
                  </div>
                ))}
              </div>
            ) : null
          )}
        </div>
      )}
    </div>
  );
};

export default PodTable;
