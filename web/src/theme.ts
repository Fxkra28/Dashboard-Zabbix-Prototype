// HCML palette, primary #0067B1, Inter font (loaded in index.html), rounded cards.
export const theme = {
  primary: '#0067B1',
  primaryDark: '#004A80',
  primaryLight: '#3B8FCB',
  bg: '#F4F7FB',
  surface: '#FFFFFF',
  text: '#1B2733',
  muted: '#64748B',
  border: '#E2E8F0',
  good: '#2E9E5B',
  ok: '#0067B1',
};

// Zabbix severities 0..5, names + colors matching Zabbix's own palette.
export const SEVERITIES = [
  { level: 0, name: 'Not classified', color: '#97AAB3' },
  { level: 1, name: 'Information', color: '#7499FF' },
  { level: 2, name: 'Warning', color: '#FFC859' },
  { level: 3, name: 'Average', color: '#FFA059' },
  { level: 4, name: 'High', color: '#E97659' },
  { level: 5, name: 'Disaster', color: '#E45959' },
] as const;
