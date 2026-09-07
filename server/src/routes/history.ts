import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  // Raw history for one item.  ?itemid=&hours=1&history=<value_type>
  // history value type: 0=float, 1=char, 2=log, 3=uint, 4=text — must match the item.
  app.get('/api/history', (req) => {
    const { itemid, hours = '1', history = '0' } = req.query as {
      itemid?: string;
      hours?: string;
      history?: string;
    };
    const from = Math.floor(Date.now() / 1000) - Number(hours) * 3600;
    return cached(`hist:${itemid}:${hours}:${history}`, 15_000, () =>
      zbx('history.get', {
        itemids: [itemid],
        history: Number(history),
        time_from: from,
        sortfield: 'clock',
        sortorder: 'ASC',
      }),
    );
  });

  // Long ranges → trends (hourly aggregates), not history (instruct §10).  ?itemid=&hours=168
  app.get('/api/trend', (req) => {
    const { itemid, hours = '168' } = req.query as { itemid?: string; hours?: string };
    const from = Math.floor(Date.now() / 1000) - Number(hours) * 3600;
    return cached(`trend:${itemid}:${hours}`, 60_000, () =>
      zbx('trend.get', { itemids: [itemid], time_from: from }),
    );
  });
}
