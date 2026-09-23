import { describe, expect, it } from 'vitest';
import { deviceClass, naturalCompare, siteFromHostName, wanPairKey } from '../naming.js';

/**
 * What a host's name says about it. No HCML host carries a `site` tag, so these
 * functions place the estate on the Sites page, in the derived service tree and
 * in the assistant's answers. Every name below is a real HCML host name.
 */
describe('siteFromHostName', () => {
  it.each([
    ['1.2.1 IDX02CORESWITCH', 1],
    ['2.1. SUB11FW01', 2], // HCML's own stray trailing dot
    ['4.3.3 FPSO ARUBA 3', 4],
    ['9.1.1 WHP-MBH_IE3200_AS01', 9],
    ['11.3.5 MOPU ARUBA 5', 11],
    ['14.3.1 TWSB REPEATER DMR 1', 14],
    ['INET : SAMPANG WAN 1', 3],
    ['INET : JAKARTA WAN 2 (JATAYU)', 1],
    ['INET : FPSO INTERNET 3 (BACKUP)', 4],
    ['INET : TWSB LINI 2 WAN 1', 14],
    ['SERVER : CUCM SURABAYA', 2],
  ])('places %s at site %i', (name, code) => {
    expect(siteFromHostName(name)?.code).toBe(code);
  });

  it.each(['WEB : MS TEAMS', 'INTERNET', 'Zabbix server', 'Huawei WAC-650', '99.1 NOT A SITE'])(
    'does not guess a site for %s',
    (name) => {
      expect(siteFromHostName(name)).toBeNull();
    },
  );
});

describe('wanPairKey', () => {
  it('pairs the legs of one WAN path', () => {
    expect(wanPairKey('INET : SAMPANG WAN 1')).toEqual({ path: 'SAMPANG', leg: '1' });
    expect(wanPairKey('INET : SAMPANG WAN 2')).toEqual({ path: 'SAMPANG', leg: '2' });
    expect(wanPairKey('INET : JAKARTA WAN 1 (ARTHATEL)')).toEqual({ path: 'JAKARTA', leg: '1', provider: 'ARTHATEL' });
    expect(wanPairKey('INET : FPSO INTERNET 3 (BACKUP)')).toEqual({ path: 'FPSO', leg: '3', provider: 'BACKUP' });
    // Two TWSB offices are two different paths, not three legs of one.
    expect(wanPairKey('INET : TWSB LINI 2 WAN 1')?.path).toBe('TWSB LINI 2');
    expect(wanPairKey('INET : TWSB OFFICE WAN 2')?.path).toBe('TWSB OFFICE');
  });

  it('ignores everything that is not a WAN leg', () => {
    expect(wanPairKey('INTERNET')).toBeNull();
    expect(wanPairKey('1.1 IDX02FW01')).toBeNull();
  });
});

describe('deviceClass', () => {
  it('prefers the monitoring template, then the name', () => {
    expect(deviceClass('14.1 TWSB-LINI2', 'FortiGate by SNMP')).toBe('firewall');
    expect(deviceClass('9.1.1 WHP-MBH_IE3200_AS01', 'Cisco IOS by SNMP')).toBe('switch');
    expect(deviceClass('2.1. SUB11FW01')).toBe('firewall');
    expect(deviceClass('7.2.1 Moxa Switch')).toBe('switch');
    expect(deviceClass('4.3.3 FPSO ARUBA 3')).toBe('access-point');
    expect(deviceClass('4.4.1 FPSO REPEATER DMR 1', 'ICMP Ping')).toBe('repeater');
  });

  it('recognises the service prefixes whatever the template says', () => {
    expect(deviceClass('INET : MOPU WAN 1', 'ICMP Ping')).toBe('wan-link');
    expect(deviceClass('WEB : PDMS.HCML.CO.ID')).toBe('web');
    expect(deviceClass('SERVER : DNS JAKARTA')).toBe('server');
  });
});

describe('naturalCompare', () => {
  it('orders numbered names the way people read them', () => {
    expect(['1.2.10 B', '1.2.2 A', '11.1 C', '2.1 D'].sort(naturalCompare)).toEqual([
      '1.2.2 A',
      '1.2.10 B',
      '2.1 D',
      '11.1 C',
    ]);
  });
});
