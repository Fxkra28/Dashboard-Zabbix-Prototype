import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useSearchPatch } from '../hooks/useUrlState';
import type { Host, Item } from '../types';
import { GraphView } from '../components/TimeSeriesChart';
import ItemPicker from '../components/ItemPicker';
import RangePicker, { useUrlRange } from '../components/RangePicker';
import { Empty, ErrorState, Loading } from '../components/states';
import { Field, FieldGroup } from '../components/Field';
import { groupBySite } from '../lib/sites';

const MAX_ITEMS = 4;

/** Items to show when a host is opened without a selection: its ping latency, else the first item. */
function defaultItems(items: Item[]): string[] {
  const preferred = items.find((i) => i.key_ === 'icmppingsec') ?? items.find((i) => i.key_.startsWith('icmpping'));
  const first = preferred ?? items[0];
  return first ? [first.itemid] : [];
}

/**
 * Graphs: one host, up to four of its items, any range.
 * URL: /graphs?hostid=10668&itemid=69356,69710&range=7d  (or month= / from=&to=)
 */
export default function HostDetail() {
  const hostsQ = useAsync<Host[]>(() => api.hosts(), []);
  const [params] = useSearchParams();
  const [range, setRange] = useUrlRange(24);

  const hostid = params.get('hostid') ?? '';
  const itemParam = params.get('itemid') ?? '';
  const itemids = useMemo(
    () => itemParam.split(',').filter((s) => /^\d+$/.test(s)).slice(0, MAX_ITEMS),
    [itemParam],
  );

  const update = useSearchPatch();

  const groups = useMemo(
    () => groupBySite(hostsQ.data ?? [], (h) => h.name, (h) => h.site),
    [hostsQ.data],
  );
  const host = hostsQ.data?.find((h) => h.hostid === hostid);
  // Without a host list no host can be chosen, so say so rather than wait for ever.
  const hostsFailed = hostsQ.error !== null && hostsQ.data == null;
  const hostsEmpty = !hostsQ.loading && !hostsFailed && groups.length === 0;

  // A deep link with items but no host: find the host from the first item.
  const resolving = useRef(false);
  useEffect(() => {
    if (hostid || !itemids.length || resolving.current) return;
    resolving.current = true;
    api
      .itemsById(itemids)
      .then((items) => {
        const h = items[0]?.hosts?.[0]?.hostid;
        if (h) update({ hostid: h });
      })
      .catch(() => undefined)
      .finally(() => (resolving.current = false));
  }, [hostid, itemids, update]);

  // No host and nothing to resolve: open the first host.
  useEffect(() => {
    if (!hostid && !itemids.length && groups.length) update({ hostid: groups[0].items[0].hostid });
  }, [hostid, itemids.length, groups, update]);

  const onItems = useCallback(
    (items: Item[]) => {
      const valid = itemids.filter((id) => items.some((i) => i.itemid === id));
      if (valid.length === itemids.length && valid.length) return;
      const next = valid.length ? valid : defaultItems(items);
      update({ itemid: next.length ? next.join(',') : null });
    },
    [itemids, update],
  );

  return (
    <>
      <div className="controls">
        <Field label="Host" htmlFor="graph-host">
          <select
            id="graph-host"
            value={hostid}
            onChange={(e) => update({ hostid: e.target.value, itemid: null })}
          >
            {!host && (
              <option value={hostid}>
                {hostsQ.loading ? 'Loading hosts…' : hostsFailed ? 'Hosts unavailable' : hostsEmpty ? 'No hosts' : 'Select a host'}
              </option>
            )}
            {groups.map((g) => (
              <optgroup key={g.key} label={g.label}>
                {g.items.map((h) => (
                  <option key={h.hostid} value={h.hostid}>
                    {h.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <FieldGroup label="Range">
          <RangePicker value={range} onChange={setRange} />
        </FieldGroup>
      </div>

      <div className="graph-layout">
        <div className="panel graph-side">
          <h2>Items</h2>
          {hostid ? (
            <ItemPicker
              hostid={hostid}
              selected={itemids}
              max={MAX_ITEMS}
              onItems={onItems}
              onChange={(ids) => update({ itemid: ids.length ? ids.join(',') : null })}
            />
          ) : hostsFailed ? (
            <ErrorState message={hostsQ.error as string} />
          ) : hostsEmpty ? (
            <Empty>No hosts to show.</Empty>
          ) : (
            <Loading label="Loading hosts…" />
          )}
        </div>
        <div className="panel graph-main">
          <h2>{host?.name ?? 'Graph'}</h2>
          <GraphView
            itemids={itemids}
            range={range}
            empty="No values in this range (the item may report rarely, or not at all)."
          />
        </div>
      </div>
    </>
  );
}
