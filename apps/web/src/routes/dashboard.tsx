import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import {
  Check,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  RefreshCw,
  Square,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { RepoStateBadge, RunStateBadge } from "@/components/ui/state-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Terminal, TermLine } from "@/components/ui/terminal";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import {
  formatDuration,
  formatTimestamp,
  queryKeys,
  useCurrentRun,
  useMe,
  useNow,
  useRepoStatus,
  useRuns,
} from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { appRoute } from "./app";
import type { PublicRun } from "@simbox/shared/types";

const STARTING_STATES = new Set(["dispatching", "queued", "booting", "closing"]);

// ---- header ----

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function PageHeader() {
  const me = useMe();
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {me.data ? `${greeting()}, ${me.data.login} — ` : ""}
        your sims run on GitHub Actions in your own repo.
      </p>
    </div>
  );
}

// ---- toolbar ----

function Toolbar() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.currentRun }),
      queryClient.invalidateQueries({ queryKey: queryKeys.repoStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.runs }),
    ]);

  const copySim = async () => {
    try {
      await navigator.clipboard.writeText("simbox sim");
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border-y border-border py-2">
      <span className="font-mono text-xs text-muted-foreground">workspace</span>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => void copySim()}
          >
            {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
            simbox sim
          </TooltipTrigger>
          <TooltipContent>Copy command</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => void refresh()}
            aria-label="Refresh"
          >
            <RefreshCw className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ---- repository panel (side column) ----

function RepoPanel() {
  const status = useRepoStatus();
  const queryClient = useQueryClient();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.repoStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.runs }),
      queryClient.invalidateQueries({ queryKey: queryKeys.currentRun }),
    ]);

  const repair = useMutation({
    mutationFn: api.repairRepo,
    onSettled: invalidate,
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectRepo,
    onSettled: invalidate,
  });

  const repo = status.data?.repo ?? null;

  if (status.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Repository</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!repo) {
    return null; // the getting-started card covers the empty state
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="truncate font-mono">{repo.fullName}</CardTitle>
          <CardDescription className="flex items-center gap-2">
            {repo.private ? (
              <Badge variant="warning">
                <Lock className="size-3" />
                private
              </Badge>
            ) : (
              <Badge variant="muted">public</Badge>
            )}
            <RepoStateBadge state={repo.state} />
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {repo.private ? (
          <Notice variant="warning">
            <TriangleAlert />
            <span className="text-xs">
              Private repo: macOS minutes are billed at a <strong>10× multiplier</strong>. Each run
              can burn ~10 hours of metered minutes.
            </span>
          </Notice>
        ) : null}

        {repo.state === "pending_pr" ? (
          <Notice variant="warning">
            <TriangleAlert />
            <span className="text-xs">
              Setup is waiting on a pull request.{" "}
              {repo.prUrl ? (
                <a
                  href={repo.prUrl}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  Merge this PR to finish
                </a>
              ) : null}
            </span>
          </Notice>
        ) : null}

        {repo.state === "needs_repair" ? (
          <Notice variant="destructive">
            <CircleAlert />
            <span className="text-xs">
              The repo setup is broken (workflow file or secret missing, or Actions disabled). Hit{" "}
              <strong>Repair</strong> to re-install.
            </span>
          </Notice>
        ) : null}

        {repo.state === "uninstalled" ? (
          <Notice variant="destructive">
            <CircleAlert />
            <span className="text-xs">
              The GitHub App was uninstalled from this repo.{" "}
              <Link
                to="/onboarding"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Re-run onboarding
              </Link>{" "}
              to reconnect.
            </span>
          </Notice>
        ) : null}

        {repair.isError ? (
          <Notice variant="destructive">
            <CircleAlert />
            <span className="text-xs">
              Repair failed:{" "}
              {repair.error instanceof ApiError ? repair.error.message : "unknown error"}
            </span>
          </Notice>
        ) : null}
        {disconnect.isError ? (
          <Notice variant="destructive">
            <CircleAlert />
            <span className="text-xs">
              Disconnect failed:{" "}
              {disconnect.error instanceof ApiError ? disconnect.error.message : "unknown error"}
            </span>
          </Notice>
        ) : null}

        <div className="flex gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            disabled={repair.isPending}
            onClick={() => repair.mutate()}
          >
            {repair.isPending ? <Loader2 className="animate-spin" /> : <Wrench />}
            Repair
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmDisconnect(true)}
          >
            Disconnect
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${repo.fullName}?`}
        body="This removes the simbox workflow and SIMBOX_TOKEN secret, cancels any live run, and frees your repo slot. You can reconnect later."
        confirmLabel="Disconnect"
        busy={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(undefined, { onSettled: () => setConfirmDisconnect(false) })
        }
      />
    </Card>
  );
}

/** Shown when no repo is connected — replaces the repo panel. */
function GettingStartedPanel() {
  const status = useRepoStatus();
  if (status.isLoading || status.data?.repo) return null;

  return (
    <Card className="relative overflow-hidden">
      <div className="bg-dot-grid pointer-events-none absolute inset-0 text-foreground/[0.07]" />
      <CardHeader className="relative">
        <CardTitle>Getting started</CardTitle>
        <CardDescription>Three steps to your first remote simulator.</CardDescription>
      </CardHeader>
      <CardContent className="relative flex flex-col gap-3">
        <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
          <li className="flex gap-2.5">
            <span className="font-mono text-xs text-primary">1.</span>
            Connect a repo to host the runner
          </li>
          <li className="flex gap-2.5">
            <span className="font-mono text-xs text-primary">2.</span>
            <span>
              <code className="font-mono text-foreground">npm i -g @touchtechclub/simbox</code>{" "}
              &amp; <code className="font-mono text-foreground">simbox login</code>
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="font-mono text-xs text-primary">3.</span>
            <code className="font-mono text-foreground">simbox sim</code>
          </li>
        </ol>
        <Button asChild size="sm" className="self-start">
          <Link to="/onboarding">Connect a repo</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---- live run panel (main column) ----

function EmptyRunState() {
  return (
    <Card className="relative overflow-hidden">
      <div className="bg-plus-grid pointer-events-none absolute inset-0" />
      <div className="bg-dot-grid pointer-events-none absolute inset-0 text-foreground/[0.07]" />
      <CardContent className="relative flex flex-col items-center gap-4 py-14 text-center">
        <p className="text-sm text-muted-foreground">
          No active run. Start one from your terminal:
        </p>
        <Terminal title="your machine" className="w-full max-w-sm text-left">
          <TermLine prompt>simbox sim</TermLine>
          <TermLine comment># boots a macOS runner, tunnels sims to you</TermLine>
        </Terminal>
      </CardContent>
    </Card>
  );
}

function LiveRunPanel() {
  const current = useCurrentRun();
  const queryClient = useQueryClient();
  const now = useNow();
  const [revealToken, setRevealToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const stop = useMutation({
    mutationFn: (runId: string) => api.stopRun(runId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.currentRun });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });

  const run: PublicRun | null = current.data?.run ?? null;

  if (current.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Live run</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!run) return <EmptyRunState />;

  const isLive = run.state === "live";

  const copyConnect = async () => {
    const cmd = `export AGENT_DEVICE_DAEMON_AUTH_TOKEN=${run.daemonToken ?? ""}\nagent-device connect proxy --daemon-base-url ${run.tunnelUrl ?? ""}/agent-device`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex flex-col gap-1">
          <CardTitle>Live run</CardTitle>
          <CardDescription className="flex items-center gap-2">
            <RunStateBadge state={run.state} />
            {run.ghRunId ? <span className="font-mono text-xs">gh run #{run.ghRunId}</span> : null}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setConfirmStop(true)}>
          <Square />
          Stop
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "uptime", value: formatDuration(now - run.createdAt) },
            { label: "devices", value: String(run.activeDevices) },
            {
              label: "android",
              value: run.androidReady ? "ready" : "preparing…",
              tone: run.androidReady ? "text-success" : "text-warning",
            },
            {
              label: "expires in",
              value: run.expiresAt ? formatDuration(run.expiresAt - now) : "—",
            },
          ].map((item) => (
            <div key={item.label} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className={cn("font-mono text-sm tabular-nums", item.tone)}>{item.value}</dd>
            </div>
          ))}
        </dl>

        {isLive && run.tunnelUrl ? (
          <div className="flex flex-col gap-3">
            <Terminal title="connect from your machine">
              <TermLine comment># exports + proxy connect</TermLine>
              <TermLine>
                <span className="text-zinc-500">export</span> AGENT_DEVICE_DAEMON_AUTH_TOKEN=
                <span className="text-amber-400">
                  {revealToken ? (run.daemonToken ?? "") : "••••••••••••••••"}
                </span>
              </TermLine>
              <TermLine>
                <span className="text-zinc-500">agent-device</span> connect proxy --daemon-base-url{" "}
                {run.tunnelUrl}/agent-device
              </TermLine>
            </Terminal>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void copyConnect()}>
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy connect command"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRevealToken((v) => !v)}>
                {revealToken ? <EyeOff /> : <Eye />}
                {revealToken ? "Hide token" : "Reveal token"}
              </Button>
            </div>
          </div>
        ) : null}

        {STARTING_STATES.has(run.state) && run.state !== "closing" ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            runner is coming up — connect command appears when it&apos;s live
          </p>
        ) : null}

        {stop.isError ? (
          <Notice variant="destructive">
            <CircleAlert />
            <span className="text-xs">
              Stop failed: {stop.error instanceof ApiError ? stop.error.message : "unknown error"}
            </span>
          </Notice>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop this run?"
        body="The GitHub Actions job will be cancelled and all connected devices will drop."
        confirmLabel="Stop run"
        busy={stop.isPending}
        onConfirm={() => stop.mutate(run.id, { onSettled: () => setConfirmStop(false) })}
      />
    </Card>
  );
}

// ---- history table ----

function HistoryPanel() {
  const runs = useRuns();
  const list = runs.data?.runs ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>Recent runs on your repo.</CardDescription>
      </CardHeader>
      <CardContent>
        {runs.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : runs.isError ? (
          <Notice variant="destructive">
            <CircleAlert />
            Failed to load run history.
          </Notice>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>run</TableHead>
                <TableHead>state</TableHead>
                <TableHead>created</TableHead>
                <TableHead>ended</TableHead>
                <TableHead>reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">
                    {r.id.slice(0, 8)}
                    {r.ghRunId ? ` · #${r.ghRunId}` : ""}
                  </TableCell>
                  <TableCell>
                    <RunStateBadge state={r.state} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTimestamp(r.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTimestamp(r.endedAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {r.endReason ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Dashboard() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader />
      <Toolbar />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <LiveRunPanel />
        </div>
        <div className="flex flex-col gap-4">
          <RepoPanel />
          <GettingStartedPanel />
        </div>
      </div>
      <HistoryPanel />
    </div>
  );
}

export const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboard",
  component: Dashboard,
});
