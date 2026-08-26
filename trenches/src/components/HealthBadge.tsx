import { useEffect, useState } from "react";
import { getWorkerHealth } from "../api/client";
import type { WorkerHeartbeat } from "../api/types";

const POLL_INTERVAL_MS = 60_000;

type Status = "loading" | "live" | "degraded" | "down";

export function HealthBadge() {
  const [scanJob, setScanJob] = useState<WorkerHeartbeat | undefined>(undefined);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    const poll = async () => {
      try {
        const health = await getWorkerHealth();
        const scan = health.jobs.find((j) => j.job === "scan");
        setScanJob(scan);
        setStatus(computeStatus(scan));
      } catch {
        setStatus("down");
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="health-badge" data-status={status} title={tooltipFor(status, scanJob)}>
      <span className="health-badge__dot" />
      {labelFor(status)}
    </span>
  );
}

function computeStatus(scan: WorkerHeartbeat | undefined): Status {
  if (!scan) return "down";
  if (scan.stale) return "down";
  if (scan.lastError) return "degraded";
  return "live";
}

function labelFor(status: Status): string {
  switch (status) {
    case "loading":
      return "Checking…";
    case "live":
      return "Live";
    case "degraded":
      return "Degraded";
    case "down":
      return "Not scanning";
  }
}

function tooltipFor(status: Status, scan: WorkerHeartbeat | undefined): string {
  if (status === "loading") return "Checking scanner status…";
  if (!scan) return "The scanner hasn't reported in yet.";
  const lastRun = new Date(scan.lastRunAt).toLocaleTimeString();
  if (status === "down") return `Scanner hasn't run recently. Last seen ${lastRun}.`;
  if (status === "degraded") return `Scanner is running but its last cycle errored: ${scan.lastError}`;
  return `Scanner is running normally. Last cycle: ${lastRun}.`;
}
