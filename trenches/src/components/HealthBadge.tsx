import { useEffect, useState } from "react";
import { getWorkerHealth, ApiError } from "../api/client";
import type { WorkerHeartbeat } from "../api/types";

const POLL_INTERVAL_MS = 60_000;

/**
 * After this many consecutive unreachable results we stop polling. A content blocker
 * (uBlock, Brave Shields) or an offline device fails every attempt identically and forever,
 * and each one logs its own net::ERR_* line in the console — retrying past this point buys
 * nothing and just fills the console. A reload re-arms it.
 */
const MAX_UNREACHABLE_ATTEMPTS = 3;

type Status = "loading" | "live" | "degraded" | "down" | "unknown";

/**
 * `streamConnected` folds the live-alert push connection into this one indicator. It used to be a
 * separate "Live" pill in the Live Feed header while this badge sat beside the wallet - two
 * different facts (is the scanner running / is my socket open) sharing one word on the same
 * screen. They are reported together now: the label is the scanner's state, and the dot pulses
 * only while alerts are actually being pushed rather than polled for.
 */
export function HealthBadge({ streamConnected = false }: { streamConnected?: boolean }) {
  const [scanJob, setScanJob] = useState<WorkerHeartbeat | undefined>(undefined);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let unreachableCount = 0;

    const poll = async () => {
      try {
        const health = await getWorkerHealth();
        if (cancelled) return;
        unreachableCount = 0;
        const scan = health.jobs.find((j) => j.job === "scan");
        setScanJob(scan);
        setStatus(computeStatus(scan));
      } catch (err) {
        if (cancelled) return;
        // An ApiError means the server answered and told us something is wrong — that is a
        // real signal about the scanner. Anything else means the request never got there
        // (blocked by an extension, offline, DNS), which says nothing about the scanner at
        // all. Reporting that as "Not scanning" would be asserting something we can't know.
        if (err instanceof ApiError) {
          unreachableCount = 0;
          setScanJob(undefined);
          setStatus("down");
          return;
        }
        unreachableCount += 1;
        setScanJob(undefined);
        setStatus("unknown");
        if (unreachableCount >= MAX_UNREACHABLE_ATTEMPTS && interval !== undefined) {
          clearInterval(interval);
          interval = undefined;
        }
      }
    };

    void poll();
    interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (interval !== undefined) clearInterval(interval);
    };
  }, []);

  return (
    <span
      className="health-badge"
      data-status={status}
      data-stream={streamConnected ? "on" : "off"}
      title={tooltipFor(status, scanJob, streamConnected)}
    >
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
    case "unknown":
      return "Status unavailable";
  }
}

function tooltipFor(status: Status, scan: WorkerHeartbeat | undefined, streamConnected: boolean): string {
  const push = streamConnected
    ? " New alerts are pushed the moment they happen."
    : " New alerts will arrive on the next refresh rather than instantly.";
  return baseTooltip(status, scan) + (status === "live" ? push : "");
}

function baseTooltip(status: Status, scan: WorkerHeartbeat | undefined): string {
  if (status === "loading") return "Checking scanner status…";
  if (status === "unknown") {
    return "Couldn't reach the scanner status endpoint — often a browser extension or ad blocker blocking the request. This doesn't affect the scanner itself.";
  }
  if (!scan) return "The scanner hasn't reported in yet.";
  const lastRun = new Date(scan.lastRunAt).toLocaleTimeString();
  if (status === "down") return `Scanner hasn't run recently. Last seen ${lastRun}.`;
  if (status === "degraded") return `Scanner is running but its last cycle errored: ${scan.lastError}`;
  return `Scanner is running normally. Last cycle: ${lastRun}.`;
}
