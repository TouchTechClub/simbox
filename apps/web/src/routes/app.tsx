import { createRoute, Outlet, useRouterState } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { rootRoute } from "./root";

const CRUMBS: Record<string, string> = {
  "/dashboard": "overview",
  "/onboarding": "setup",
  "/runners": "runners",
};

/** Pathless layout route: wraps dashboard + onboarding in the app shell. */
function AppLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return <AppShell crumb={CRUMBS[pathname] ?? "overview"}>{<Outlet />}</AppShell>;
}

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});
