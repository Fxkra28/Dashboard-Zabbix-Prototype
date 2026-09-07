import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';
import { config } from '../config.js';

/**
 * Network monitoring (instruct §13). The portal never speaks SNMP — it just
 * reads the ICMP / SNMP-LLD items Zabbix already collects, exactly like any host.
 * These views populate automatically once real devices are onboarded (§13.4).
 */
export async function netRoutes(app: FastifyInstance): Promise<void> {
  // Devices in the network host groups, each enriched with ICMP availability.
  app.get('/api/net/devices', () =>
    cached('net:devices', 30_000, async () => {
      const hostParams: Record<string, unknown> = {
        output: ['hostid', 'name', 'status'],
        selectInterfaces: ['ip', 'type'],
        sortfield: 'name',
      };
      if (config.netGroupIds.length) hostParams.groupids = config.netGroupIds;

      const hosts = await zbx<{ hostid: string; name: string; status: string }[]>(
        'host.get',
        hostParams,
      );
      const hostids = hosts.map((h) => h.hostid);

      // ICMP items: icmpping (up/down), icmppingloss (%), icmppingsec (latency).
      let icmp: { hostid: string; key_: string; lastvalue: string }[] = [];
      if (hostids.length) {
        icmp = await zbx('item.get', {
          hostids,
          output: ['itemid', 'hostid', 'key_', 'lastvalue', 'units'],
          search: { key_: 'icmpping' },
          startSearch: true,
        });
      }

      const byHost: Record<string, { up?: boolean; loss?: number; latency?: number }> = {};
      for (const it of icmp) {
        const b = (byHost[it.hostid] ??= {});
        if (it.key_.startsWith('icmppingloss')) b.loss = Number(it.lastvalue);
        else if (it.key_.startsWith('icmppingsec')) b.latency = Number(it.lastvalue);
        else if (it.key_.startsWith('icmpping')) b.up = it.lastvalue === '1';
      }

      return hosts.map((h) => ({ ...h, icmp: byHost[h.hostid] ?? null }));
    }),
  );

  // Interfaces / ports of one device (SNMP LLD traffic items) with latest values.
  app.get('/api/net/ports', (req) => {
    const { hostid } = req.query as { hostid?: string };
    return cached(`net:ports:${hostid}`, 15_000, () =>
      zbx('item.get', {
        hostids: [hostid],
        search: { key_: 'net.if.' },
        startSearch: true,
        output: ['itemid', 'name', 'key_', 'lastvalue', 'units', 'value_type'],
        sortfield: 'name',
      }),
    );
  });

  // Oper status (up/down) items per port.
  app.get('/api/net/status', (req) => {
    const { hostid } = req.query as { hostid?: string };
    return cached(`net:status:${hostid}`, 15_000, () =>
      zbx('item.get', {
        hostids: [hostid],
        search: { key_: 'ifOperStatus' },
        startSearch: true,
        output: ['itemid', 'name', 'key_', 'lastvalue'],
        sortfield: 'name',
      }),
    );
  });

  // Topology map.  ?mapid=
  app.get('/api/net/map', (req) => {
    const { mapid } = req.query as { mapid?: string };
    return zbx('map.get', {
      sysmapids: [mapid],
      selectSelements: 'extend',
      selectLinks: 'extend',
    });
  });
}
