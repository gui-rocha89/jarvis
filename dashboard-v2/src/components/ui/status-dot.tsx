'use client';

interface StatusDotProps {
  status: 'online' | 'offline' | 'warning' | 'loading';
  label?: string;
  size?: 'sm' | 'md';
}

const colors = {
  online: 'bg-stark-green',
  offline: 'bg-stark-red',
  warning: 'bg-stark-gold',
  loading: 'bg-stark-dim animate-pulse',
};

export function StatusDot({ status, label, size = 'sm' }: StatusDotProps) {
  const dotSize = size === 'sm' ? 'w-2 h-2' : 'w-3 h-3';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`${dotSize} rounded-full ${colors[status]}`} />
      {label && <span className="text-xs text-stark-text-dim">{label}</span>}
    </span>
  );
}
