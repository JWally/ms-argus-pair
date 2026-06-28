import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wordmark } from '../components/Brand';
import { fetchLeaderboard, type LeaderboardRow } from '../lib/pair';

export function ClaimSpot() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchLeaderboard();
        if (!cancelled) setLeaderboard(rows);
      } catch {
        /* keep empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-10 px-6 py-10 sm:py-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Wordmark />
        <Link className="pill" to="/merchant">
          Merchant
        </Link>
      </header>
      <main className="contest-panel card card-accent p-7 sm:p-8">
        <div className="label">contest</div>
        <h1 className="mt-3 text-3xl font-semibold leading-tight">Claim your spot.</h1>
        <div className="mt-7 border-t border-edge/60 pt-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="label">Scoreboard</h2>
            <span className="label text-muted/70">top 25</span>
          </div>
          <ol className="space-y-1">
            {leaderboard.map((row, i) => (
              <li
                className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2 font-mono text-sm text-white/80"
                key={row.code}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="w-7 shrink-0 text-right tabular-nums text-muted/70">
                    {i + 1}
                  </span>
                  <span className="truncate">{row.code}</span>
                </span>
                <span className="tabular-nums text-muted">{row.count}</span>
              </li>
            ))}
          </ol>
        </div>
      </main>
    </div>
  );
}
