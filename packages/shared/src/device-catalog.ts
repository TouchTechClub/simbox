import type { DeviceProfile } from "./device-profile.js";
import type { DevicePlatform, RunnerTarget } from "./runners.js";

/** A simulator device type (iOS) or AVD hardware profile (Android). */
export interface CatalogModel {
  /** simctl device type identifier, or avdmanager profile id. */
  id: string;
  name: string;
  foldable?: boolean;
}

/** An iOS simulator runtime or Android system-image API level. */
export interface CatalogOs {
  version: string;
  name: string;
  /** Model ids this OS can run; absent means every model. */
  models?: string[];
}

/** What a runner image offers, as reported by the runner itself. */
export interface DeviceCatalog {
  /** Newest first. */
  os: CatalogOs[];
  /** In preference order: phones before tablets, newest first. */
  models: CatalogModel[];
  /** What the runner boots when nothing is requested. */
  defaults: { model: string; os: string };
  /** iOS: installed Xcode versions, newest first. */
  xcode?: string[];
}

/** A catalog plus where and when it was observed. */
export interface RunnerInventory extends DeviceCatalog {
  platform: DevicePlatform;
  runner: RunnerTarget;
  reportedAt: number;
}

/** The device a run actually booted. */
export interface BootedDevice {
  model: string;
  os: string;
  /** Human name to pass to `exec --device`. */
  name: string;
  /** Simulator UDID or emulator serial. */
  id?: string;
}

export type DevicePick =
  | { ok: true; model: CatalogModel; os: CatalogOs }
  | { ok: false; error: string };

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const norm = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, " ");

function findModel(models: CatalogModel[], wanted: string): CatalogModel | undefined {
  const key = norm(wanted);
  return models.find((m) => norm(m.id) === key) ?? models.find((m) => norm(m.name) === key);
}

/** Versions matching a request; "18" matches 18.x, "latest"/"oldest" pick an end. */
function matchingOs(list: CatalogOs[], wanted: string): CatalogOs[] {
  const sorted = [...list].sort((a, b) => compareVersions(b.version, a.version));
  if (wanted === "latest") return sorted.slice(0, 1);
  if (wanted === "oldest") return sorted.slice(-1);
  return sorted.filter((os) => os.version === wanted || os.version.startsWith(`${wanted}.`));
}

const runs = (os: CatalogOs, model: CatalogModel) => !os.models || os.models.includes(model.id);

const list = (values: string[]) =>
  values.length > 12 ? `${values.slice(0, 12).join(", ")}, …` : values.join(", ");

/**
 * Choose a model and OS from a runner's catalog. Unspecified fields prefer the
 * runner's defaults, then the newest compatible choice. A pairing the runner
 * cannot boot is an error that lists what it can, never a silent substitution.
 */
export function pickDevice(selector: DeviceProfile | null, catalog: DeviceCatalog): DevicePick {
  const osWanted = selector?.os;
  const osChoices = osWanted ? matchingOs(catalog.os, osWanted) : null;
  if (osChoices && osChoices.length === 0)
    return {
      ok: false,
      error: `OS ${osWanted} is not available on this runner (available: ${list(catalog.os.map((os) => os.version))}).`,
    };

  let model: CatalogModel | undefined;
  if (selector?.model) {
    model = findModel(catalog.models, selector.model);
    if (!model)
      return {
        ok: false,
        error: `Device "${selector.model}" is not available on this runner (available: ${list(catalog.models.map((m) => m.name))}).`,
      };
  } else if (selector?.foldable) {
    model = catalog.models.find((m) => m.foldable);
    if (!model) return { ok: false, error: "This runner has no foldable device profile." };
  }

  const defaultOs = catalog.os.find((os) => os.version === catalog.defaults.os);
  const defaultModel = findModel(catalog.models, catalog.defaults.model);
  const newestFirst = [...catalog.os].sort((a, b) => compareVersions(b.version, a.version));

  if (model) {
    const candidates = osChoices ?? [
      ...(defaultOs ? [defaultOs] : []),
      ...newestFirst.filter((os) => os !== defaultOs),
    ];
    const os = candidates.find((candidate) => runs(candidate, model!));
    if (!os)
      return {
        ok: false,
        error: osWanted
          ? `${model.name} cannot run OS ${osWanted} on this runner (it runs: ${list(newestFirst.filter((o) => runs(o, model!)).map((o) => o.version)) || "none"}).`
          : `No OS on this runner can run ${model.name}.`,
      };
    return { ok: true, model, os };
  }

  const osList = osChoices ?? (defaultOs ? [defaultOs] : newestFirst.slice(0, 1));
  for (const os of osList) {
    if (defaultModel && runs(os, defaultModel)) return { ok: true, model: defaultModel, os };
    const fallback = catalog.models.find((m) => !m.foldable && runs(os, m));
    if (fallback) return { ok: true, model: fallback, os };
  }
  return { ok: false, error: `No device on this runner can run OS ${osWanted ?? "default"}.` };
}

const MAX_ENTRIES = 400;
const TEXT = /^[\w .()+,'/:-]{1,120}$/;

/** Bounded, printable catalog from an untrusted runner report. */
export function validateCatalog(value: unknown): DeviceCatalog {
  if (!value || typeof value !== "object") throw new Error("Expected a device catalog.");
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => typeof x === "string" && TEXT.test(x);
  if (!Array.isArray(v.os) || !Array.isArray(v.models) || v.os.length > MAX_ENTRIES)
    throw new Error("Catalog needs os and models arrays.");
  if (v.models.length > MAX_ENTRIES) throw new Error("Too many models.");
  const models: CatalogModel[] = v.models.map((m: any) => {
    if (!m || !text(m.id) || !text(m.name)) throw new Error("Invalid model entry.");
    return { id: m.id, name: m.name, ...(m.foldable === true ? { foldable: true } : {}) };
  });
  const os: CatalogOs[] = v.os.map((o: any) => {
    if (!o || !text(o.version) || !text(o.name)) throw new Error("Invalid OS entry.");
    if (o.models !== undefined && (!Array.isArray(o.models) || !o.models.every(text)))
      throw new Error("Invalid OS model list.");
    return {
      version: o.version,
      name: o.name,
      ...(o.models ? { models: (o.models as string[]).slice(0, MAX_ENTRIES) } : {}),
    };
  });
  const d = v.defaults as Record<string, unknown> | undefined;
  if (!d || !text(d.model) || !text(d.os)) throw new Error("Catalog needs defaults.");
  const xcode = Array.isArray(v.xcode) ? v.xcode.filter(text).slice(0, 40) : undefined;
  return {
    os,
    models,
    defaults: { model: d.model as string, os: d.os as string },
    ...(xcode ? { xcode: xcode as string[] } : {}),
  };
}

export function validateBootedDevice(value: unknown): BootedDevice {
  const v = (value ?? {}) as Record<string, unknown>;
  const text = (x: unknown) => typeof x === "string" && TEXT.test(x);
  if (!text(v.model) || !text(v.os) || !text(v.name) || (v.id !== undefined && !text(v.id)))
    throw new Error("Invalid resolved device.");
  return {
    model: v.model as string,
    os: v.os as string,
    name: v.name as string,
    ...(v.id !== undefined ? { id: v.id as string } : {}),
  };
}
