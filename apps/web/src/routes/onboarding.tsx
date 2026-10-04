import { useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  GitBranch,
  Loader2,
  Lock,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { RepoStateBadge } from "@/components/ui/state-badge";
import { Terminal, TermLine } from "@/components/ui/terminal";
import { api, ApiError, GITHUB_APP_INSTALL_URL } from "@/lib/api";
import type { InstallableRepo } from "@/lib/api";
import { queryKeys, useInstallations, useMe, useRepoStatus } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { appRoute } from "./app";

type Step = "install" | "pick" | "progress";

const STEPS: { id: Step; label: string }[] = [
  { id: "install", label: "Install app" },
  { id: "pick", label: "Pick repo" },
  { id: "progress", label: "Connect" },
];

function StepIndicator({ step }: { step: Step }) {
  const activeIdx = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
        return (
          <li key={s.id} className="flex items-center gap-2">
            {i > 0 ? <span className="h-px w-6 bg-border" /> : null}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-xs",
                state === "active" && "border-primary/50 text-primary",
                state === "done" && "border-border text-muted-foreground",
                state === "todo" && "border-border text-muted-foreground/60",
              )}
            >
              {state === "done" ? (
                <CheckCircle2 className="size-3.5 text-primary" />
              ) : (
                <span>{i + 1}</span>
              )}
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Step 1+2: poll installations; once repos are reachable, show the picker. */
function InstallAndPick({ onPicked }: { onPicked: () => void }) {
  const installations = useInstallations(true); // poll every 4s
  const repos = installations.data ?? [];
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const queryClient = useQueryClient();

  const step: Step = repos.length > 0 ? "pick" : "install";
  const selectedRepo = repos.find((r) => r.repoId === selected) ?? null;

  const connect = async (repo: InstallableRepo) => {
    setConnecting(true);
    setError(null);
    try {
      await api.connectRepo({
        repo_id: repo.repoId,
        full_name: repo.fullName,
        private: repo.private,
        default_branch: repo.defaultBranch,
        installation_id: repo.installationId,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.repoStatus });
      onPicked();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to connect repo");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <StepIndicator step={step} />

      {repos.length === 0 ? (
        <Card className="relative overflow-hidden">
          <div className="bg-dot-grid pointer-events-none absolute inset-0 text-foreground/10" />
          <CardHeader className="relative">
            <CardTitle>Install the GitHub App</CardTitle>
            <CardDescription>
              Simbox commits one workflow file and one secret to a repo you choose. Install the app,
              grant access to a repo, and it will appear here automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="relative flex flex-col gap-4">
            <div>
              <Button asChild>
                <a href={GITHUB_APP_INSTALL_URL}>Install the Simbox GitHub App</a>
              </Button>
            </div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              waiting for an installation…
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Pick a repository</CardTitle>
            <CardDescription>
              Simbox runs entirely inside one repo&apos;s Actions. One repo per account.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Repository">
              {repos.map((r) => {
                const isSelected = selected === r.repoId;
                return (
                  <button
                    key={r.repoId}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    disabled={connecting}
                    onClick={() => setSelected(r.repoId)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-foreground/30",
                      isSelected && "border-primary/60 bg-primary/5",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-full border",
                          isSelected ? "border-primary text-primary" : "border-border",
                        )}
                      >
                        {isSelected ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                      </span>
                      <span className="truncate font-mono text-sm">{r.fullName}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      {r.private ? (
                        <Badge variant="warning">
                          <Lock className="size-3" />
                          private
                        </Badge>
                      ) : (
                        <Badge variant="muted">public</Badge>
                      )}
                      <span className="flex items-center gap-1 font-mono">
                        <GitBranch className="size-3" />
                        {r.defaultBranch}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {repos.some((r) => r.private) ? (
              <Notice variant="warning">
                <TriangleAlert />
                <span>
                  Private repos bill GitHub Actions minutes at a{" "}
                  <strong>10× multiplier on macOS runners</strong>. Public repos are free.
                </span>
              </Notice>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Missing a repo?{" "}
                <a
                  href={GITHUB_APP_INSTALL_URL}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Update the app installation
                </a>
                .
              </p>
              <Button
                disabled={!selectedRepo || connecting}
                onClick={() => selectedRepo && void connect(selectedRepo)}
              >
                {connecting ? <Loader2 className="animate-spin" /> : null}
                Connect repo
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {error ? (
        <Notice variant="destructive">
          <CircleAlert />
          {error}
        </Notice>
      ) : null}
    </>
  );
}

/** Step 3: poll /v1/repo/status until the connection lands. */
function Progress() {
  const status = useRepoStatus(true);
  const repo = status.data?.repo ?? null;
  const me = useMe();

  if (!repo) {
    return (
      <>
        <StepIndicator step="progress" />
        <Card>
          <CardHeader>
            <CardTitle>Connecting</CardTitle>
            <CardDescription>Setting up your repository.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2.5 text-sm">
              {["Committing simbox.yml workflow", "Writing SIMBOX_TOKEN secret"].map((label) => (
                <li key={label} className="flex items-center gap-2.5 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-primary" />
                  {label}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </>
    );
  }

  const ok = repo.state === "ok";

  return (
    <>
      <StepIndicator step="progress" />
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle className="font-mono">{repo.fullName}</CardTitle>
            <CardDescription>Repository connection</CardDescription>
          </div>
          <RepoStateBadge state={repo.state} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2.5 text-sm">
            {[
              {
                label: "Workflow committed to default branch",
                done: ok || repo.state === "pending_pr",
              },
              { label: "SIMBOX_TOKEN secret written", done: ok || repo.state === "pending_pr" },
              { label: "Installation verified", done: ok },
            ].map((item) => (
              <li
                key={item.label}
                className={cn(
                  "flex items-center gap-2.5",
                  item.done ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {item.done ? (
                  <CheckCircle2 className="size-4 text-primary" />
                ) : (
                  <Circle className="size-4" />
                )}
                {item.label}
              </li>
            ))}
          </ul>

          {repo.state === "pending_pr" ? (
            <Notice variant="warning">
              <TriangleAlert />
              <span>
                Your default branch is protected, so Simbox opened a pull request with the workflow
                file.{" "}
                {repo.prUrl ? (
                  <a
                    href={repo.prUrl}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Merge this PR to finish setup
                  </a>
                ) : (
                  "Merge the open PR to finish setup"
                )}{" "}
                — this page will update automatically.
                <span className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  waiting for the PR to merge…
                </span>
              </span>
            </Notice>
          ) : null}

          {ok ? (
            <>
              <Notice variant="info">
                <CheckCircle2 className="text-primary" />
                <span>
                  Connected. The <code className="font-mono">simbox.yml</code> workflow is on your
                  default branch and the <code className="font-mono">SIMBOX_TOKEN</code> secret is
                  set.
                </span>
              </Notice>
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">Get a simulator from your terminal:</p>
                <Terminal title="your machine">
                  <TermLine prompt>npm i -g @touchtechclub/simbox</TermLine>
                  <TermLine prompt>simbox login</TermLine>
                  <TermLine prompt>simbox sim</TermLine>
                </Terminal>
              </div>
              <div className="flex items-center justify-between gap-3">
                {me.data ? (
                  <p className="text-xs text-muted-foreground">
                    Signed in as <span className="font-mono">{me.data.login}</span>.
                  </p>
                ) : (
                  <span />
                )}
                <Button asChild>
                  <Link to="/dashboard">Go to dashboard</Link>
                </Button>
              </div>
            </>
          ) : null}

          {repo.state === "needs_repair" || repo.state === "uninstalled" ? (
            <Notice variant="destructive">
              <CircleAlert />
              <span>
                Setup hit a problem (repo state: <code className="font-mono">{repo.state}</code>).
                Try again from the dashboard, or re-run onboarding.
              </span>
            </Notice>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

function Onboarding() {
  const status = useRepoStatus();
  const [step, setStep] = useState<Step | null>(null);

  // If a repo is already connected (e.g. user re-visited /onboarding), jump
  // straight to the progress/success step.
  useEffect(() => {
    if (step === null && status.data) {
      setStep(status.data.connected && status.data.repo ? "progress" : "install");
    }
  }, [status.data, step]);

  if (step === null) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        loading…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Set up Simbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a repository — your sims run on its GitHub Actions minutes.
        </p>
      </div>

      {step === "progress" ? <Progress /> : <InstallAndPick onPicked={() => setStep("progress")} />}
    </div>
  );
}

export const onboardingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/onboarding",
  component: Onboarding,
});
