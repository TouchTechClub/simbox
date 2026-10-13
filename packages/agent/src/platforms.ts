/** An unavailable optional platform must never prevent provisioning another. */
export async function preparePlatforms(options: {
  warmIOS: boolean;
  ios: () => Promise<void>;
  /** Lighter than the full warmup: one booted simulator, no XCTest. */
  bootIOS?: () => Promise<void>;
  android: () => Promise<void>;
  warn: (message: string) => void;
}): Promise<void> {
  if (options.warmIOS) {
    try {
      await options.ios();
    } catch (error) {
      options.warn(`optional iOS warmup failed; continuing Android preparation: ${String(error)}`);
    }
  } else if (options.bootIOS) {
    try {
      await options.bootIOS();
    } catch (error) {
      options.warn(`default iOS simulator did not boot: ${String(error)}`);
    }
  }
  await options.android();
}
