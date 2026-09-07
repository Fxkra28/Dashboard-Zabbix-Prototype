// Minimal inline SVG icon set (stroke = currentColor).
type P = { size?: number };
const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconOverview = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);

export const IconAlert = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export const IconHost = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="18" height="8" rx="1.5" />
    <rect x="3" y="14" width="18" height="6" rx="1.5" />
    <line x1="7" y1="8" x2="7" y2="8" />
    <line x1="7" y1="17" x2="7" y2="17" />
  </svg>
);

export const IconNetwork = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="5" r="2.2" />
    <circle cx="5" cy="19" r="2.2" />
    <circle cx="19" cy="19" r="2.2" />
    <path d="M12 7.2v4.3M12 11.5 5.8 17M12 11.5 18.2 17" />
  </svg>
);

export const IconLatest = ({ size }: P) => (
  <svg {...base(size)}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <circle cx="3.5" cy="6" r="1.3" />
    <circle cx="3.5" cy="12" r="1.3" />
    <circle cx="3.5" cy="18" r="1.3" />
  </svg>
);

export const IconGraph = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3 3v18h18" />
    <path d="M7 14l3-4 3 3 4-6" />
  </svg>
);

export const IconMap = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
    <line x1="9" y1="4" x2="9" y2="18" />
    <line x1="15" y1="6" x2="15" y2="20" />
  </svg>
);

export const IconReport = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M14 3v5h5" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

export const IconChevron = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
