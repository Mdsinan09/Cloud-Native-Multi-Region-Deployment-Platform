import React from 'react';
import { Globe, CheckCircle, XCircle, Loader2 } from 'lucide-react';

interface SubDeployment {
  id: string;
  region: string;
  status: string;
  ingress_host: string | null;
  health_check_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface RegionCardProps {
  subDeployment: SubDeployment;
}

const RegionCard: React.FC<RegionCardProps> = ({ subDeployment }) => {
  const statusIcons: Record<string, React.ReactNode> = {
    SUCCESS: <CheckCircle className="w-5 h-5 text-green-500" />,
    ROLLED_BACK: <XCircle className="w-5 h-5 text-orange-500" />,
    DEPLOYING: <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />,
    HEALTH_CHECK: <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />,
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe className="w-5 h-5 text-gray-600" />
          <h4 className="font-semibold text-gray-900">{subDeployment.region}</h4>
        </div>
        {statusIcons[subDeployment.status] || <span className="text-gray-400">●</span>}
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Status</span>
          <span className="font-medium">{subDeployment.status}</span>
        </div>
        {subDeployment.ingress_host && (
          <div className="flex justify-between">
            <span className="text-gray-500">Host</span>
            <span className="font-mono text-blue-600 text-xs">{subDeployment.ingress_host}</span>
          </div>
        )}
        {subDeployment.health_check_url && (
          <div className="flex justify-between">
            <span className="text-gray-500">Health URL</span>
            <span className="font-mono text-xs truncate max-w-[200px]">{subDeployment.health_check_url}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default RegionCard;
