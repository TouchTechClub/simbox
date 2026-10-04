import { createRoute, redirect } from "@tanstack/react-router";
import { TerminalSquare } from "lucide-react";

import { GitHubIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Terminal, TermLine } from "@/components/ui/terminal";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { rootRoute } from "./root";

/** Left half of the split auth screen: brand + terminal vignette. */
function AuthPanel() {
  return (
    <div className="bg-plus-grid relative hidden flex-col justify-between overflow-hidden border-r border-border bg-muted/30 p-10 lg:flex">
      <div className="relative flex items-center gap-2 font-semibold">
        <span className="flex size-7 items-center justify-center rounded-md border border-border bg-background">
          <TerminalSquare className="size-4 text-primary" />
        </span>
        <span className="font-mono tracking-tight">simbox</span>
      </div>

      <div className="relative max-w-md">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight">
          Simulators &amp; emulators on your GitHub Actions minutes.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          A macOS runner in your own repo boots iOS sims and Android emulators, tunnels them to your
          machine, and tears itself down when you&apos;re done. Public repos cost nothing.
        </p>

        <Terminal className="mt-8 shadow-xl" title="simbox — zsh">
          <TermLine prompt>simbox sim</TermLine>
          <TermLine comment># dispatching → queued → booting → live (2m 41s)</TermLine>
          <TermLine>
            tunnel <span className="text-zinc-500">https://…trycloudflare.com</span>
          </TermLine>
          <TermLine prompt>agent-device open Safari --platform ios</TermLine>
          <TermLine>
            <span className="text-emerald-400">●</span> iPhone 16 Pro · iOS 18.5
          </TermLine>
        </Terminal>
      </div>

      <p className="relative font-mono text-xs text-muted-foreground">
        free on public repos · ~6h per run · your minutes, your runner
      </p>
    </div>
  );
}

function Landing() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <AuthPanel />

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 font-semibold lg:hidden">
            <span className="flex size-7 items-center justify-center rounded-md border border-border bg-muted">
              <TerminalSquare className="size-4 text-primary" />
            </span>
            <span className="font-mono tracking-tight">simbox</span>
          </div>

          <h2 className="text-xl font-semibold tracking-tight">Sign in to Simbox</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Use the GitHub account that owns the repo your sims will run in.
          </p>

          <Button
            variant="outline"
            size="lg"
            className="mt-6 w-full"
            onClick={() => {
              // signIn.social redirects to GitHub itself when given callbackURL.
              void authClient.signIn.social({
                provider: "github",
                callbackURL: `${window.location.origin}/dashboard`,
              });
            }}
          >
            <GitHubIcon className="size-4" />
            Continue with GitHub
          </Button>

          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            Powered by the Simbox GitHub App — it requests{" "}
            <span className="font-mono">contents</span>, <span className="font-mono">secrets</span>{" "}
            and <span className="font-mono">actions</span> access on repos you install it to.
          </p>
        </div>
      </div>
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    // Already authed? Skip the landing — resume a pending flow (e.g. CLI
    // device approval) if there is one, else go to the dashboard.
    try {
      await api.me();
    } catch {
      return;
    }
    let back: string | null = null;
    try {
      back = sessionStorage.getItem("simbox_return_to");
      sessionStorage.removeItem("simbox_return_to");
    } catch {
      /* ignore */
    }
    if (back && back !== "/") throw redirect({ href: back });
    throw redirect({ to: "/dashboard" });
  },
  component: Landing,
});
