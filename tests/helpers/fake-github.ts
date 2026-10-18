/**
 * Just enough of the GitHub REST API for the Simbox API's integration tests:
 * one repository with a workflow file, dispatches that create workflow runs,
 * secrets, branches and pull requests.
 */
export interface FakeRun {
  id: number;
  status: string;
  conclusion: string | null;
  display_title: string;
  inputs: Record<string, string>;
}

export function fakeGithub(options: { fullName: string; repoId: number }) {
  const state = {
    /** Workflow file per branch; null deletes it. */
    files: new Map<string, string>(),
    protectedDefault: false,
    /** The committed workflow declares a simbox_run input. */
    acceptsRunId: true,
    /** Reject runner_labels too (a pre-runner-selection workflow). */
    rejectAllInputs: false,
    runs: [] as FakeRun[],
    cancelled: [] as number[],
    secrets: new Map<string, string>(),
    pulls: [] as Array<{ head: string; base: string; html_url: string }>,
    /** Per user OAuth token: push access to the repository. */
    pushAccess: new Map<string, boolean>(),
    nextRunId: 1000,
    calls: [] as string[],
  };
  const repo = {
    id: options.repoId,
    full_name: options.fullName,
    default_branch: "main",
    private: true,
  };
  const prefix = `/repos/${options.fullName}`;

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const auth = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    state.calls.push(`${method} ${path}`);

    if (path === `/repositories/${options.repoId}`) return Response.json(repo);
    if (path === prefix && method === "GET") {
      if (!state.pushAccess.has(auth))
        return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({
        ...repo,
        permissions: { push: state.pushAccess.get(auth), pull: true },
      });
    }
    if (path === `${prefix}/actions/workflows/simbox.yml/dispatches`) {
      const inputs = body.inputs as Record<string, string>;
      if (state.rejectAllInputs || (inputs.simbox_run && !state.acceptsRunId))
        return Response.json(
          {
            message: `Unexpected inputs provided: ["${inputs.simbox_run ? "simbox_run" : "runner_labels"}"]`,
          },
          { status: 422 },
        );
      const id = state.nextRunId++;
      state.runs.push({
        id,
        status: "queued",
        conclusion: null,
        display_title: inputs.simbox_run
          ? `simbox ${inputs.platform} ${inputs.simbox_run}`
          : "simbox",
        inputs,
      });
      return new Response(null, { status: 204 });
    }
    if (path === `${prefix}/actions/workflows/simbox.yml/runs`)
      return Response.json({
        total_count: state.runs.length,
        workflow_runs: [...state.runs].reverse(),
      });
    const runMatch = /\/actions\/runs\/(\d+)(\/cancel)?$/.exec(path);
    if (runMatch && path.startsWith(prefix)) {
      const run = state.runs.find((r) => r.id === Number(runMatch[1]));
      if (!run) return Response.json({ message: "Not Found" }, { status: 404 });
      if (runMatch[2]) {
        if (run.status === "completed")
          return Response.json({ message: "Cannot cancel a completed run" }, { status: 409 });
        state.cancelled.push(run.id);
        return new Response(null, { status: 202 });
      }
      return Response.json(run);
    }
    if (path === `${prefix}/actions/secrets/public-key`)
      return Response.json({
        key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        key_id: "test-key",
      });
    if (path.startsWith(`${prefix}/actions/secrets/`)) {
      const name = path.split("/").pop()!;
      if (method === "DELETE") state.secrets.delete(name);
      else state.secrets.set(name, body.encrypted_value);
      return new Response(null, { status: 204 });
    }
    if (path === `${prefix}/contents/.github/workflows/simbox.yml`) {
      const branch = method === "GET" ? (url.searchParams.get("ref") ?? "main") : body.branch;
      if (method === "GET") {
        const text = state.files.get(branch);
        if (text === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json({
          sha: `sha-${branch}`,
          encoding: "base64",
          content: Buffer.from(text)
            .toString("base64")
            .replace(/(.{60})/g, "$1\n"),
        });
      }
      if (branch === "main" && state.protectedDefault)
        return Response.json({ message: "Protected branch" }, { status: 403 });
      if (method === "DELETE") state.files.delete(branch);
      else state.files.set(branch, Buffer.from(body.content, "base64").toString());
      return Response.json({});
    }
    if (path === `${prefix}/git/ref/heads/main`)
      return Response.json({ object: { sha: "main-sha" } });
    if (path === `${prefix}/git/refs`) {
      const branch = String(body.ref).replace("refs/heads/", "");
      if (state.files.has(branch) || branch === "main")
        return Response.json({ message: "Reference already exists" }, { status: 422 });
      const main = state.files.get("main");
      if (main !== undefined) state.files.set(branch, main);
      return Response.json({});
    }
    if (path === `${prefix}/pulls`) {
      if (method === "GET")
        return Response.json(
          state.pulls.filter((p) => url.searchParams.get("head")?.endsWith(`:${p.head}`)),
        );
      if (state.pulls.some((p) => p.head === body.head))
        return Response.json({ message: "A pull request already exists" }, { status: 422 });
      const pr = {
        head: body.head,
        base: body.base,
        html_url: `https://github.com/${options.fullName}/pull/${state.pulls.length + 1}`,
      };
      state.pulls.push(pr);
      return Response.json({ ...pr, number: state.pulls.length });
    }
    throw new Error(`Unexpected GitHub call ${method} ${path}`);
  };

  /** Merge the setup PR: its branch's workflow lands on main. */
  const mergeSetupPr = () => {
    const pr = state.pulls.pop();
    if (pr) state.files.set("main", state.files.get(pr.head)!);
  };

  return { state, fetch, mergeSetupPr };
}
