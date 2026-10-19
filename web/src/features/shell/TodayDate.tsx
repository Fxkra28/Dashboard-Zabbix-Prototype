import { useNow } from '../../shared/hooks/useNow';

/** Today's date, re-read every minute so a tab left open turns over at midnight. Its own component, so only this span re-renders. */
export default function TodayDate() {
  const now = useNow(60_000);
  return <span>{new Date(now).toLocaleDateString()}</span>;
}
