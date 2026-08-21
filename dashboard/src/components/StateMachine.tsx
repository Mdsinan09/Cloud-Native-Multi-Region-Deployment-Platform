import React from 'react';

const STATES = [
  'QUEUED',
  'CLONING',
  'BUILDING',
  'PUSHING',
  'DEPLOYING',
  'HEALTH_CHECK',
  'SUCCESS',
] as const;

const FAILED_STATES = [
  'HEALTH_CHECK_FAILED',
  'ROLLING_BACK',
  'ROLLED_BACK',
] as const;

interface StateMachineProps {
  status: string;
}

const StateMachine: React.FC<StateMachineProps> = ({ status }) => {
  const isFailed = FAILED_STATES.includes(status as any);
  const activeIndex = STATES.indexOf(status as any);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2 overflow-x-auto">
        {STATES.map((state, index) => {
          let stateClass = 'bg-gray-200 text-gray-500';
          if (isFailed && index > activeIndex && index < STATES.length - 1) {
            stateClass = 'bg-gray-200 text-gray-400';
          } else if (index < activeIndex) {
            stateClass = 'bg-green-500 text-white';
          } else if (index === activeIndex) {
            stateClass = status === 'SUCCESS' 
              ? 'bg-green-600 text-white' 
              : 'bg-blue-600 text-white animate-pulse';
          }

          return (
            <React.Fragment key={state}>
              <div className="flex flex-col items-center min-w-[80px]">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${stateClass}`}>
                  {index + 1}
                </div>
                <span className="text-[10px] mt-1 text-gray-600 uppercase tracking-wider text-center">
                  {state.replace('_', ' ')}
                </span>
              </div>
              {index < STATES.length - 1 && (
                <div className={`flex-1 h-1 mx-1 min-w-[20px] ${index < activeIndex ? 'bg-green-500' : 'bg-gray-200'}`} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {isFailed && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center gap-2 text-red-700 font-semibold">
            <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            {status.replace('_', ' ')}
          </div>
        </div>
      )}
    </div>
  );
};

export default StateMachine;
