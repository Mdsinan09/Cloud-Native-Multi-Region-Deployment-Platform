import React from 'react';
import { Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

interface Event {
  id: string;
  event: string;
  message: string | null;
  created_at: string;
}

interface DeploymentTimelineProps {
  events: Event[];
}

const DeploymentTimeline: React.FC<DeploymentTimelineProps> = ({ events }) => {
  const getIcon = (event: string) => {
    if (event.includes('SUCCESS') || event === 'SUCCESS') return <CheckCircle className="w-5 h-5 text-green-500" />;
    if (event.includes('FAIL') || event.includes('ERROR')) return <XCircle className="w-5 h-5 text-red-500" />;
    if (event.includes('ROLLING_BACK')) return <AlertCircle className="w-5 h-5 text-orange-500" />;
    return <Clock className="w-5 h-5 text-blue-500" />;
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-900">Event Log</h3>
      <div className="relative border-l-2 border-gray-200 ml-3 space-y-6">
        {events.map((evt) => (
          <div key={evt.id} className="relative pl-6">
            <div className="absolute -left-[9px] top-0 bg-white rounded-full">
              {getIcon(evt.event)}
            </div>
            <div className="bg-white rounded-lg border border-gray-100 p-3 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm text-gray-900">{evt.event}</span>
                <span className="text-xs text-gray-500">
                  {new Date(evt.created_at).toLocaleTimeString()}
                </span>
              </div>
              {evt.message && (
                <p className="text-sm text-gray-600 mt-1 font-mono break-all">{evt.message}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default DeploymentTimeline;
