import { expect, test } from "bun:test";
import {
  DEFAULT_RUNNERS,
  emptyRunnerPreferences,
  parseRunnerInput,
  parseRunnerPatch,
  resolveRunner,
  sameRunner,
  validateRunner,
} from "../packages/shared/src/runners.js";

test("runner precedence is CLI, repository, account, then GitHub; platform inheritance is independent", () => {
  const account = {
    ios: { labels: ["blacksmith-6vcpu-macos-latest"] },
    android: { labels: ["blacksmith-2vcpu-ubuntu-2404"] },
  };
  const repo = { ios: null, android: { labels: ["blacksmith-4vcpu-ubuntu-2404"] } };
  expect(resolveRunner("android", account, repo, DEFAULT_RUNNERS.android)).toEqual({
    runner: DEFAULT_RUNNERS.android,
    source: "override",
  });
  expect(resolveRunner("android", account, repo)).toEqual({
    runner: repo.android,
    source: "repository",
  });
  expect(resolveRunner("ios", account, repo)).toEqual({ runner: account.ios, source: "account" });
  expect(resolveRunner("android", emptyRunnerPreferences(), null)).toEqual({
    runner: DEFAULT_RUNNERS.android,
    source: "default",
  });
  expect(resolveRunner("android", account, { ios: null, android: null }).runner).toEqual(
    account.android,
  );
});

test("custom labels accept arrays without permitting expressions, YAML or commands", () => {
  expect(parseRunnerInput('["self-hosted","linux","x64","kvm"]', "android")).toEqual({
    labels: ["self-hosted", "linux", "x64", "kvm"],
  });
  expect(parseRunnerInput("my custom runner", "ios").labels).toEqual(["my custom runner"]);
  for (const input of [
    "",
    "${{ secrets.TOKEN }}",
    "runner;echo bad",
    "runner\nname",
    "$(id)",
    "[]",
    '["duplicate","duplicate"]',
    '["label",1]',
    '["label"',
    "a".repeat(101),
  ]) {
    expect(() => parseRunnerInput(input, "android")).toThrow();
  }
  expect(() => validateRunner({ labels: ["runner"], group: "admin" }, "ios")).toThrow();
  expect(() => validateRunner({ labels: Array(9).fill("runner") }, "ios")).toThrow();
});

test("known incompatible runner families are rejected before dispatch", () => {
  for (const label of [
    "macos-latest",
    "ubuntu-24.04-arm",
    "blacksmith-4vcpu-ubuntu-2404-arm",
    "windows-latest",
    "ubuntu-slim",
  ]) {
    expect(() => parseRunnerInput(label, "android")).toThrow();
  }
  for (const label of [
    "ubuntu-latest",
    "blacksmith-4vcpu-ubuntu-2404",
    "macos-15-intel",
    "windows-2025",
    "x64",
  ]) {
    expect(() => parseRunnerInput(label, "ios")).toThrow();
  }
  expect(parseRunnerInput('["self-hosted","macOS","ARM64"]', "ios").labels).toHaveLength(3);
});

test("settings patches reject malformed shapes and reset only the requested platform", () => {
  expect(parseRunnerPatch({ android: null })).toEqual({ android: null });
  expect(parseRunnerPatch({ ios: { labels: ["macos-latest"] } })).toEqual({
    ios: { labels: ["macos-latest"] },
  });
  for (const input of [
    null,
    [],
    {},
    "default",
    { scope: "account" },
    { ios: undefined },
    { android: "ubuntu-latest" },
  ])
    expect(() => parseRunnerPatch(input)).toThrow();
  expect(
    sameRunner({ labels: ["linux", "self-hosted"] }, { labels: ["self-hosted", "linux"] }),
  ).toBe(true);
  expect(sameRunner(null, DEFAULT_RUNNERS.android)).toBe(false);
  expect(
    sameRunner({ labels: ["Linux", "SELF-HOSTED"] }, { labels: ["self-hosted", "linux"] }),
  ).toBe(true);
  expect(() => parseRunnerInput('["linux","LINUX"]', "android")).toThrow("unique");
});
