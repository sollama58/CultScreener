import { useEffect, useState } from "react";
import { getStreamHealth, getWorkerHealth } from "../../api/client";
import type { StreamHealth, WorkerHeartbeat } from "../../api/types";

const POLL_INTERVAL_MS = 30_000;

/** Every job's full heartbeat, not just "scan" - the navbar's HealthBadge only surfaces that one. */
export function AdminMonitoring() {
  const [jobs, setJobs] = useState<WorkerHeartbeat[]>([]);
  const [stream, setStream] = useState<StreamHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPolled, setLastPolled] = useState<Date | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        // Fetched together but reported separately: a dead push channel and a dead worker are
        // different problems with different fixes, and the stream failing must not blank out the
        // job table that would tell you the worker is fine.
        const [health, streamHealth] = await Promise.allSettled([getWorkerHealth(), getStreamHealth()]);
        if (health.status === "fulfilled") {
          setJobs(health.value.jobs);
          setError(null);
        } else {
          setError("Failed to reach the API's /health/worker endpoint.");
        }
        setStream(streamHealth.status === "fulfilled" ? streamHealth.value : null);
        setLastPolled(new Date());
      } catch {
        setError("Failed to reach the API's /health/worker endpoint.");
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="dashboard__header">
        <h3>Worker jobs</h3>
        {lastPolled && <span className="dashboard__updated">Updated {lastPolled.toLocaleTimeString()}</span>}
      </div>

      {error && <p className="empty-state">{error}</p>}
      {!error && jobs.length === 0 && <p className="empty-state">No jobs have reported in yet.</p>}

      {stream && (
        // dt/dd have to live inside a dl to be valid markup - and this reuses the Config tab's
        // own row styling rather than inventing a second look for one line.
        <dl className="admin-config">
          <div className="admin-config__row">
            <dt>Live alert push</dt>
            <dd>
              <span className={`badge ${stream.connected ? "badge--on" : "badge--off"}`}>
                {stream.connected ? "Connected" : "Down"}
              </span>{" "}
              {stream.subscribers} {stream.subscribers === 1 ? "dashboard" : "dashboards"} listening
              {!stream.connected && " - alerts are falling back to polling"}
            </dd>
          </div>
        </dl>
      )}

      {jobs.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Last run</th>
                <th>Last success</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.job}>
                  <td>{job.job}</td>
                  <td>
                    <span className={`badge ${jobBadgeClass(job)}`}>{jobStatusLabel(job)}</span>
                  </td>
                  <td>{new Date(job.lastRunAt).toLocaleString()}</td>
                  <td>{job.lastSuccessAt ? new Date(job.lastSuccessAt).toLocaleString() : "—"}</td>
                  <td className="admin-table__error">{job.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function jobStatusLabel(job: WorkerHeartbeat): string {
  if (job.stale) return "Stale";
  if (job.lastError) return "Erroring";
  return "Healthy";
}

function jobBadgeClass(job: WorkerHeartbeat): string {
  if (job.stale) return "badge--off";
  if (job.lastError) return "badge--warn";
  return "badge--on";
}
