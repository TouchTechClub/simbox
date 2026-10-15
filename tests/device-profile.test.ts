import { expect, test } from "bun:test";
import {
  formatDeviceProfile,
  sameDeviceProfile,
  validateDeviceProfile,
} from "../packages/shared/src/device-profile";
import {
  compareVersions,
  foldableTarget,
  rankXcodeBundles,
  xcodeCandidates,
} from "../packages/agent/src/xcode";

test("device profiles accept only foldable and an iOS Xcode version", () => {
  expect(validateDeviceProfile(undefined, "ios")).toBeNull();
  expect(validateDeviceProfile({}, "android")).toBeNull();
  expect(validateDeviceProfile({ foldable: false }, "ios")).toBeNull();
  expect(validateDeviceProfile({ foldable: true, xcode: "27.1" }, "ios")).toEqual({
    foldable: true,
    xcode: "27.1",
  });
  expect(validateDeviceProfile({ foldable: true }, "android")).toEqual({ foldable: true });
  expect(() => validateDeviceProfile({ xcode: "27.1" }, "android")).toThrow("iOS");
  expect(() => validateDeviceProfile({ xcode: "27.1; rm -rf /" }, "ios")).toThrow();
  expect(() => validateDeviceProfile({ foldable: "yes" }, "ios")).toThrow();
  expect(() => validateDeviceProfile({ hinge: 90 }, "ios")).toThrow();
  expect(() => validateDeviceProfile([], "ios")).toThrow();
});

test("device profiles compare and print by what they prepare", () => {
  expect(sameDeviceProfile(null, {})).toBe(true);
  expect(sameDeviceProfile({ foldable: true }, null)).toBe(false);
  expect(sameDeviceProfile({ xcode: "27.1" }, { xcode: "27.1" })).toBe(true);
  expect(formatDeviceProfile(null, "ios")).toBe("default");
  expect(formatDeviceProfile({ foldable: true, xcode: "27.1" }, "ios")).toBe(
    "iPhone Duo, Xcode 27.1",
  );
  expect(formatDeviceProfile({ foldable: true }, "android")).toBe("Android foldable");
});

test("Xcode bundles rank releases before betas, newest first", () => {
  expect(compareVersions("27.1", "27.0.1")).toBeGreaterThan(0);
  expect(compareVersions("27", "27.0")).toBe(0);
  expect(
    rankXcodeBundles([
      "Xcode_27.1_beta.app",
      "Xcode_27.app",
      "Xcode_27.1.app",
      "Xcode_26.4.app",
      "Xcode.app",
      "Simulator.app",
    ]),
  ).toEqual(["Xcode_27.1.app", "Xcode_27.app", "Xcode_26.4.app", "Xcode_27.1_beta.app"]);
  expect(xcodeCandidates("27.1")).toEqual(["Xcode_27.1.app", "Xcode_27.1.0.app", "Xcode-27.1.app"]);
});

test("the foldable target needs an iOS runtime that supports the iPhone Duo", () => {
  const duo = {
    identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
    name: "iPhone Duo",
  };
  const phone = {
    identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    name: "iPhone 17",
  };
  const runtime = (version: string, types: Array<typeof duo>, platform = "iOS") => ({
    identifier: `com.apple.CoreSimulator.SimRuntime.${platform}-${version.replace(".", "-")}`,
    version,
    platform,
    isAvailable: true,
    supportedDeviceTypes: types,
  });
  // xcode-27 ships iOS 27.0 alone, which cannot run the Duo.
  expect(foldableTarget([phone, duo], [runtime("27.0", [phone])])).toBeNull();
  expect(foldableTarget([phone], [runtime("27.1", [phone])])).toBeNull();
  const target = foldableTarget(
    [phone, duo],
    [runtime("27.0", [phone]), runtime("27.1", [phone, duo]), runtime("27.2", [duo], "watchOS")],
  );
  expect(target?.type.name).toBe("iPhone Duo");
  expect(target?.runtime.version).toBe("27.1");
});
