import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";

export const queryKeys = {
  me: ["me"] as const,
  installations: ["installations"] as const,
  repoStatus: ["repoStatus"] as const,
  currentRun: ["currentRun"] as const,
  runs: ["runs"] as const,
  runnerSettings: ["runnerSettings"] as const,
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: api.me,
    staleTime: 60_000,
    retry: false,
  });
}

export function useInstallations(poll = false) {
  return useQuery({
    queryKey: queryKeys.installations,
    queryFn: api.installations,
    refetchInterval: poll ? 4_000 : false,
    retry: false,
  });
}

export function useRepoStatus(poll = false) {
  return useQuery({
    queryKey: queryKeys.repoStatus,
    queryFn: api.repoStatus,
    refetchInterval: poll ? 4_000 : false,
    retry: false,
  });
}

export function useCurrentRun() {
  return useQuery({
    queryKey: queryKeys.currentRun,
    queryFn: api.currentRun,
    refetchInterval: 5_000,
    retry: false,
  });
}

export function useRuns() {
  return useQuery({
    queryKey: queryKeys.runs,
    queryFn: api.runs,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Re-render every second so countdowns/uptimes stay live. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ---- time formatting ----

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "01:23:45" style duration from a millisecond delta. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** "2026-09-21 14:33" — local time, compact. */
export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
