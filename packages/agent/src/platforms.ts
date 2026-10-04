/** An unavailable optional platform must never prevent provisioning another. */
export async function preparePlatforms(options: {
  warmIOS: boolean;
  ios: () => Promise<void>;
  android: () => Promise<void>;
  warn: (message: string) => void;
}): Promise<void> {
  if (options.warmIOS) {
    try {
      await options.ios();
    } catch (error) {
      options.warn(`optional iOS warmup failed; continuing Android preparation: ${String(error)}`);
    }
  }
  await options.android();
}
