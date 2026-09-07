import type { FastifyInstance } from 'fastify';
import { zbx } from '../zabbix.js';
import { cached } from '../cache.js';

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  // Monitoring → Maps: list available network maps.
  app.get('/api/maps', () =>
    cached('maps', 60_000, () =>
      zbx('map.get', { output: ['sysmapid', 'name', 'width', 'height'] }),
    ),
  );

  // One map with its elements + links (topology).  ?mapid=
  app.get('/api/maps/detail', (req) => {
    const { mapid } = req.query as { mapid?: string };
    return cached(`map:${mapid}`, 30_000, () =>
      zbx('map.get', {
        sysmapids: [mapid],
        selectSelements: 'extend',
        selectLinks: 'extend',
        output: 'extend',
      }),
    );
  });
}
