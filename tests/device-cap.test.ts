import { expect, test } from "bun:test";
import { bootRefusal, bootTarget, devicesOverCap } from "../packages/agent/src/device-cap";
import { releaseXcodeBundles } from "../packages/agent/src/xcode";
import {
  deviceCapForCpus,
  estimateDeviceCap,
  formatRunner,
  parseRunnerInput,
  sameRunner,
  validateRunner,
} from "../packages/shared/src/runners";

test("small runners run one device; bigger ones more, up to the per-run cap", () => {
  expect([2, 3, 4, 5, 8, 12].map(deviceCapForCpus)).toEqual([1, 1, 1, 2, 2, 3]);
  expect(estimateDeviceCap("ios", { labels: ["xcode-27"] })).toBe(1);
  expect(estimateDeviceCap("ios", { labels: ["macos-latest"] })).toBe(1);
  expect(estimateDeviceCap("ios", { labels: ["macos-26-xlarge"] })).toBe(2);
  expect(estimateDeviceCap("ios", { labels: ["blacksmith-12vcpu-macos-latest"] })).toBe(3);
  expect(estimateDeviceCap("ios", { labels: ["self-hosted"], maxDevices: 3 })).toBe(3);
  expect(estimateDeviceCap("android", { labels: ["blacksmith-8vcpu-ubuntu-2404"] })).toBe(1);
  expect(estimateDeviceCap("ios", null)).toBe(1);
});

test("a runner may configure its device cap", () => {
  expect(validateRunner({ labels: ["self-hosted"], maxDevices: 2 }, "ios")).toEqual({
    labels: ["self-hosted"],
    maxDevices: 2,
  });
  expect(() => validateRunner({ labels: ["self-hosted"], maxDevices: 4 }, "ios")).toThrow("1 to 3");
  expect(() => validateRunner({ labels: ["self-hosted"], maxDevices: 1.5 }, "ios")).toThrow();
  expect(() => validateRunner({ labels: ["ubuntu-latest"], maxDevices: 2 }, "android")).toThrow(
    "one emulator",
  );
  expect(() => validateRunner({ labels: ["x"], group: "y" }, "ios")).toThrow();
  expect(parseRunnerInput('{"labels":["self-hosted"],"maxDevices":2}', "ios")).toEqual({
    labels: ["self-hosted"],
    maxDevices: 2,
  });
  expect(formatRunner({ labels: ["self-hosted"], maxDevices: 2 })).toBe("self-hosted (2 devices)");
  expect(sameRunner({ labels: ["a"], maxDevices: 2 }, { labels: ["a"] })).toBe(true);
  expect(sameRunner({ labels: ["a"] }, { labels: ["a"], maxDevices: 2 })).toBe(false);
});

test("idle devices above the cap stop, oldest first; in-use and just-booted ones never", () => {
  const now = 1_000_000;
  const booted = [
    { id: "warm", since: now - 600_000 },
    { id: "session", since: now - 500_000 },
    { id: "viewed", since: now - 400_000 },
    { id: "fresh", since: now - 10_000 },
  ];
  expect(devicesOverCap({ booted, inUse: new Set(["session"]), cap: 1, now })).toEqual([
    "warm",
    "viewed",
  ]);
  expect(devicesOverCap({ booted, inUse: new Set(["session", "viewed"]), cap: 2, now })).toEqual([
    "warm",
  ]);
  // Over the cap with everything in use: nothing is stopped.
  expect(
    devicesOverCap({ booted, inUse: new Set(["warm", "session", "viewed"]), cap: 1, now }),
  ).toEqual([]);
  expect(devicesOverCap({ booted: booted.slice(0, 1), inUse: new Set(), cap: 1, now })).toEqual([]);
});

test("a panel boot waits for a free slot; idle devices and already-booted targets do not", () => {
  const booted = new Set(["a", "b"]);
  expect(bootRefusal({ target: "c", booted, inUse: new Set(), cap: 1 })).toBeNull();
  expect(bootRefusal({ target: "b", booted, inUse: new Set(["a"]), cap: 1 })).toBeNull();
  const refusal = bootRefusal({ target: "c", booted, inUse: new Set(["a"]), cap: 1 });
  expect(refusal).toContain("runs 1 device at a time and one is in use");
  expect(refusal).toContain("simbox sim --new");
  expect(bootRefusal({ target: "c", booted, inUse: new Set(["a"]), cap: 2 })).toBeNull();
  expect(bootTarget(new URLSearchParams("udid=x"), undefined)).toBe("x");
  expect(bootTarget(new URLSearchParams(), '{"udid":"y"}')).toBe("y");
  expect(bootTarget(new URLSearchParams(), "nope")).toBeNull();
});

test("the default Xcode is the newest release, never an RC behind a release-looking link", () => {
  const names = [
    "Xcode.app",
    "Xcode_27.app",
    "Xcode_27.0.app",
    "Xcode_27.1.app",
    "Xcode_27.1.0.app",
    "Xcode_27.2.app",
    "Xcode_27.2_Release_Candidate.app",
  ];
  const links: Record<string, string> = {
    "Xcode_27.2.app": "Xcode_27.2_Release_Candidate.app",
    "Xcode_27.1.0.app": "Xcode_27.1.app",
    "Xcode_27.0.app": "Xcode_27.app",
  };
  expect(releaseXcodeBundles(names, (name) => links[name] ?? name)[0]).toBe("Xcode_27.1.app");
});
