import { describe, expect, it } from 'vitest';
import { requiredRole, roleAllows } from '../auth.js';

/**
 * The route rules are an ordered regex list where the first match wins and
 * anything unmatched falls back to `viewer`. A typo in one pattern silently
 * downgrades an endpoint, no error, no log line, just an admin report served
 * to any signed-in user. This table is the only thing that would catch it.
 */
describe('requiredRole', () => {
  const cases: [string, ReturnType<typeof requiredRole>][] = [
    ['/api/reports/inventory', 'admin'],
    ['/api/links', 'operator'],
    ['/api/net/devices', 'operator'],
    ['/api/net/ports', 'operator'],
    ['/api/problems/acknowledge', 'operator'],
    ['/api/problems/close', 'operator'],
    ['/api/hosts', 'viewer'],
    ['/api/problems', 'viewer'],
    ['/api/reports/availability', 'viewer'],
    ['/api/reports/noise', 'viewer'],
    ['/api/sla', 'viewer'],
    ['/api/explain/problem', 'viewer'],
    ['/api/chat', 'viewer'],
  ];

  it.each(cases)('%s requires %s', (url, role) => {
    expect(requiredRole(url)).toBe(role);
  });

  it('fails closed on an unknown route', () => {
    // A route added without a rule must still demand a login, never be public.
    expect(requiredRole('/api/something-invented-later')).toBe('viewer');
  });

  it('does not let a prefix collision leak the admin report', () => {
    // `/api/reports/inventory` is admin; its siblings must not inherit that,
    // and nothing else may accidentally match the inventory pattern.
    expect(requiredRole('/api/reports/aging')).toBe('viewer');
    expect(requiredRole('/api/reports/capacity')).toBe('viewer');
  });
});

describe('roleAllows', () => {
  it('permits equal or higher rank only', () => {
    expect(roleAllows('admin', 'viewer')).toBe(true);
    expect(roleAllows('admin', 'operator')).toBe(true);
    expect(roleAllows('admin', 'admin')).toBe(true);
    expect(roleAllows('operator', 'viewer')).toBe(true);
    expect(roleAllows('operator', 'operator')).toBe(true);
    expect(roleAllows('viewer', 'viewer')).toBe(true);
  });

  it('refuses to escalate', () => {
    expect(roleAllows('viewer', 'operator')).toBe(false);
    expect(roleAllows('viewer', 'admin')).toBe(false);
    expect(roleAllows('operator', 'admin')).toBe(false);
  });
});
