import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { CircleAlert, CheckCircle2, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  RUNNER_PRESETS,
  formatRunner,
  parseRunnerInput,
  sameRunner,
  type DevicePlatform,
  type RunnerPreferences,
  type RunnerTarget,
} from "@simbox/shared/runners";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/hooks";
import { appRoute } from "./app";

type Selection = { choice: string; custom: string };
function selection(runner: RunnerTarget | null, platform: DevicePlatform): Selection {
  if (!runner) return { choice: "inherit", custom: "" };
  const preset = RUNNER_PRESETS.find(
    (item) => item.platform === platform && sameRunner(item.runner, runner),
  );
  return {
    choice: preset ? preset.runner.labels[0]! : "custom",
    custom: runner.labels.length === 1 ? runner.labels[0]! : JSON.stringify(runner.labels),
  };
}

function RunnerForm({
  scope,
  initial,
  busy,
  save,
}: {
  scope: "account" | "repo";
  initial: RunnerPreferences;
  busy: boolean;
  save: (scope: "account" | "repo", values: RunnerPreferences) => Promise<unknown>;
}) {
  const [values, setValues] = useState({
    ios: selection(initial.ios, "ios"),
    android: selection(initial.android, "android"),
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const parse = (platform: DevicePlatform) =>
        values[platform].choice === "inherit"
          ? null
          : parseRunnerInput(
              values[platform].choice === "custom"
                ? values[platform].custom
                : values[platform].choice,
              platform,
            );
      await save(scope, { ios: parse("ios"), android: parse("android") });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save runners.");
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      {(["android", "ios"] as const).map((platform) => {
        const id = `${scope}-${platform}`;
        return (
          <div key={platform} className="flex flex-col gap-2">
            <Label htmlFor={id}>
              {platform === "android" ? "Android · Linux x64/KVM" : "iOS · macOS ARM64/Xcode"}
            </Label>
            <select
              id={id}
              value={values[platform].choice}
              disabled={busy}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={(event) =>
                setValues((previous) => ({
                  ...previous,
                  [platform]: { ...previous[platform], choice: event.target.value },
                }))
              }
            >
              <option value="inherit">
                {scope === "account" ? "Use GitHub default" : "Inherit account default"}
              </option>
              {RUNNER_PRESETS.filter((preset) => preset.platform === platform).map((preset) => (
                <option key={preset.runner.labels[0]} value={preset.runner.labels[0]}>
                  {preset.name}
                </option>
              ))}
              <option value="custom">Custom runner labels…</option>
            </select>
            {values[platform].choice === "custom" ? (
              <>
                <Label htmlFor={`${id}-custom`} className="text-xs">
                  Runner label or JSON label array
                </Label>
                <Input
                  id={`${id}-custom`}
                  required
                  disabled={busy}
                  value={values[platform].custom}
                  placeholder={
                    platform === "android"
                      ? '["self-hosted","linux","x64","kvm"]'
                      : '["self-hosted","macOS","ARM64"]'
                  }
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [platform]: { ...previous[platform], custom: event.target.value },
                    }))
                  }
                />
              </>
            ) : null}
          </div>
        );
      })}
      {error ? (
        <Notice variant="destructive">
          <CircleAlert />
          <span>{error}</span>
        </Notice>
      ) : null}
      <Button disabled={busy} type="submit" className="self-start">
        {busy ? <Loader2 className="animate-spin" /> : null}Save{" "}
        {scope === "account" ? "account defaults" : "repository overrides"}
      </Button>
    </form>
  );
}

function RunnersPage() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.runnerSettings,
    queryFn: api.runnerSettings,
    retry: false,
  });
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: ({ scope, values }: { scope: "account" | "repo"; values: RunnerPreferences }) =>
      api.updateRunners(scope, values),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.runnerSettings, settings);
      setSaved(true);
    },
  });
  const settings = query.data;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Runners</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          CLI override → repository override → account default → GitHub default.
        </p>
      </div>
      <Notice variant="warning">
        <CircleAlert />
        <span>
          Blacksmith requires its GitHub App on each repository and bills separately. Custom runners
          must supply the required tools and virtualization. No automatic provider fallback.{" "}
          <a
            className="underline"
            href="https://docs.blacksmith.sh/blacksmith-runners/overview"
            target="_blank"
            rel="noreferrer"
          >
            Blacksmith setup
          </a>
        </span>
      </Notice>
      <p className="text-sm text-muted-foreground">
        Settings affect future runs only and survive Repair. After upgrading an older workflow, run{" "}
        <code>simbox repair</code> once and merge its PR if your branch is protected.
      </p>
      {saved ? (
        <Notice variant="info">
          <CheckCircle2 />
          <span>Saved. An active run keeps its original runner.</span>
        </Notice>
      ) : null}
      {query.isPending ? (
        <p className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Loading runner settings…
        </p>
      ) : query.isError ? (
        <Notice variant="destructive">
          <CircleAlert />
          <span>{query.error.message}</span>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Notice>
      ) : null}
      {settings ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Effective runners</CardTitle>
              <CardDescription>
                {settings.repoFullName ?? "No repository connected"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {(["android", "ios"] as const).map((platform) => (
                <p key={platform} className="break-words text-sm">
                  <strong>{platform}</strong>:{" "}
                  <span className="font-mono">
                    {formatRunner(settings.effective[platform].runner)}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    ({settings.effective[platform].source})
                  </span>
                </p>
              ))}
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Account defaults</CardTitle>
                <CardDescription>Used by repositories without their own override.</CardDescription>
              </CardHeader>
              <CardContent>
                <RunnerForm
                  key={JSON.stringify(settings.account)}
                  scope="account"
                  initial={settings.account}
                  busy={mutation.isPending}
                  save={(scope, values) => mutation.mutateAsync({ scope, values })}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Repository overrides</CardTitle>
                <CardDescription>
                  {settings.repoFullName ?? "Connect a repository to set overrides."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {settings.repository ? (
                  <RunnerForm
                    key={`${settings.repoFullName}:${JSON.stringify(settings.repository)}`}
                    scope="repo"
                    initial={settings.repository}
                    busy={mutation.isPending}
                    save={(scope, values) => mutation.mutateAsync({ scope, values })}
                  />
                ) : (
                  <Button asChild variant="outline">
                    <Link to="/onboarding">Connect a repository</Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Agent setup</CardTitle>
          <CardDescription>
            Install the small Simbox skill with the official skills CLI.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <code className="font-mono">simbox skills install</code>
          <p className="text-muted-foreground">
            Asks current project or global, then lets you select agents and confirm installation.
            Uses bunx skills; requires Bun. No Simbox login needed.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export const runnersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/runners",
  component: RunnersPage,
});
