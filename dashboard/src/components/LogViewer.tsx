import React, { useState, useEffect, useRef } from 'react';
import { getDeploymentLogs } from '../api/client';
import {
  X,
  Download,
  RefreshCw,
  Terminal,
  Clock,
  AlertCircle,
  Globe,
} from 'lucide-react';

interface LogViewerProps {
  deploymentId: string;
  podName: string;
  region: string;
  onClose: () => void;
}

const LogViewer: React.FC<LogViewerProps> = ({ deploymentId, podName, region, onClose }) => {
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tailLines, setTailLines] = useState(100);
  const [showPrevious, setShowPrevious] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getDeploymentLogs(deploymentId, region, {
        tailLines,
        previous: showPrevious,
      });
      setLogs(response.data.logs || 'No logs available');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [deploymentId, podName, region, tailLines, showPrevious]);

  useEffect(() => {
    if (autoRefresh) {
      const interval = setInterval(fetchLogs, 3000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, tailLines, showPrevious]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const handleDownload = () => {
    const blob = new Blob([logs], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${podName}-${region}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Colorize log lines
  const colorizeLine = (line: string): string => {
    if (line.includes('ERROR') || line.includes('error') || line.includes('Error')) return 'text-red-400';
    if (line.includes('WARN') || line.includes('warn')) return 'text-yellow-400';
    if (line.includes('INFO') || line.includes('info')) return 'text-blue-400';
    if (line.match(/^\d{4}-\d{2}-\d{2}T/)) return 'text-gray-500';
    return 'text-green-400';
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-950 rounded-xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col border border-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800 rounded-t-xl">
          <div className="flex items-center gap-3">
            <Terminal className="w-5 h-5 text-green-500" />
            <div>
              <h3 className="text-sm font-semibold text-white">Pod Logs</h3>
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <span className="font-mono text-green-400">{podName}</span>
                <span className="text-gray-600">|</span>
                <Globe className="w-3 h-3" />
                <span>{region}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Tail Lines Selector */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500">Lines:</span>
              <select
                value={tailLines}
                onChange={(e) => setTailLines(Number(e.target.value))}
                className="bg-gray-800 text-white text-xs rounded px-2 py-1 border border-gray-700 outline-none"
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={500}>500</option>
                <option value={1000}>1000</option>
                <option value={-1}>All</option>
              </select>
            </div>

            {/* Previous Logs Toggle */}
            <button
              onClick={() => setShowPrevious(!showPrevious)}
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                showPrevious
                  ? 'bg-orange-900/50 border-orange-700 text-orange-400'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
              }`}
              title="Show logs from previous container instance (for crash debugging)"
            >
              <Clock className="w-3 h-3" />
              Previous
            </button>

            {/* Auto Refresh */}
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                autoRefresh
                  ? 'bg-green-900/50 border-green-700 text-green-400'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${autoRefresh ? 'animate-spin' : ''}`} />
              Auto
            </button>

            {/* Refresh */}
            <button
              onClick={fetchLogs}
              className="text-gray-400 hover:text-white transition-colors p-1"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            {/* Download */}
            <button
              onClick={handleDownload}
              className="text-gray-400 hover:text-white transition-colors p-1"
              title="Download logs as .txt"
            >
              <Download className="w-4 h-4" />
            </button>

            {/* Close */}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white transition-colors p-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Log Content */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto p-4 font-mono text-sm"
        >
          {loading ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              <RefreshCw className="w-5 h-5 animate-spin mr-2" />
              Loading logs...
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full text-red-400">
              <AlertCircle className="w-5 h-5 mr-2" />
              {error}
            </div>
          ) : (
            <div className="space-y-0.5">
              {logs.split('\n').map((line, i) => (
                <div key={i} className={`${colorizeLine(line)} whitespace-pre-wrap break-all`}>
                  {line || ' '}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-t border-gray-800 rounded-b-xl text-xs text-gray-500">
          <span>
            {logs.split('\n').length} lines
            {showPrevious && ' (from previous container)'}
          </span>
          <span>Press ESC to close</span>
        </div>
      </div>
    </div>
  );
};

export default LogViewer;
