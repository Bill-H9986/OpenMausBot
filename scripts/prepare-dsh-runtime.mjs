// Stage the embedded dsh runtime as a resolvable node_modules tree under
// dist-native/dsh/<platform>-<arch>/. The packaged app launches the runtime
// under Electron's own executable in Node mode, so it ships outside ASAR and
// must resolve its dependency closure on disk. The closure is walked through
// pnpm's .pnpm store (an entry's sibling symlinks are its resolved deps) and
// copied verbatim without symlinks: the store layout is machine-local, while
// the staged tree must resolve on the user's machine. Optional platform
// packages (libreoffice-kit, sharp, sherpa-onnx, esbuild, node-pty
// prebuilds) therefore travel exactly as the build machine resolved them.
// Slimming: a package names its target with an npm platform token
// (sharp-win32-x64, win32-arm64, sherpa-onnx-win-x64); only the staged
// target's own variants can load, so the rest are dropped. Every
// libreoffice-kit package is dropped as well: the packaged runtime then
// degrades office-document skills instead of shipping the LibreOffice
// binaries. node-pty's prebuilds are pruned to the target's own directory.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DSH_PACKAGE = "@deepseek-ai/dsh";

/** dsh is pinned exactly in the root package.json; a range would let the
 * staged runtime and the version check in the driver drift apart. */
export function pinnedDshVersion(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pin = manifest.dependencies?.[DSH_PACKAGE];
  if (!pin || /[^\d.\-a-zA-Z]/.test(pin)) {
    throw new Error(`package.json must pin ${DSH_PACKAGE} to an exact version; found ${pin ?? "nothing"}`);
  }
  return pin;
}

export function stagedDshDirectory(root, platform, arch) {
  return join(root, "dist-native", "dsh", `${platform}-${arch}`);
}

// Platform-specific packages name their target after an npm platform token
// (sharp-win32-x64, @esbuild/win32-arm64, sherpa-onnx-win-x64,
// rollup-win32-x64-msvc, plain darwin = all arches).
const PLATFORM_TOKENS = ["aix", "darwin", "linux", "s390x", "ppc64", "ia32", "armv7l", "universal", "win32", "win"];
const PLATFORM_VARIANT_RE = new RegExp("-(?:" + PLATFORM_TOKENS.join("|") + ")([-.:a-z0-9]+)*$");

function platformVariantOf(name) {
  const match = name.split("/").pop().match(PLATFORM_VARIANT_RE);
  return match ? match[0] : null;
}

function matchesTarget(variant, platform, arch) {
  if (!variant) return true;
  const parts = variant.slice(1).split(/[-.]/);
  const osName = parts[0] === "win" ? "win32" : parts[0];
  if (osName !== platform) return false;
  const rest = parts.slice(1).join("-");
  return !rest || rest === "universal" || rest.split("-").includes(arch);
}

function packageNameOf(dir) {
  const segments = dir.split(/[\\/]/);
  return segments.slice(segments.lastIndexOf("node_modules") + 1).join("/");
}

/** The pnpm closure of a package: every physical store directory reachable
 * through the sibling symlinks of each .pnpm entry, plus what each package
 * resolves for its own dependencies. One closure can carry two versions of
 * a name; the staging flattens the winner to the top level and nests the
 * other under its consumer, the layout Node's resolver expects. */
export function pnpmClosure(root, entryPoint) {
  const manifestVersion = new Map(); // physical dir -> version
  const versionOf = (dir) => {
    let version = manifestVersion.get(dir);
    if (!version) {
      version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      manifestVersion.set(dir, version);
    }
    return version;
  };
  const byName = new Map(); // name -> Map(version -> physical dir)
  const consumerNeeds = new Map(); // physical consumer dir -> Map(dep name -> version)
  const seen = new Set();
  const queue = [realpathSync(join(root, "node_modules", ...entryPoint.split("/")))];
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const name = packageNameOf(dir);
    const versions = byName.get(name) ?? new Map();
    versions.set(versionOf(dir), dir);
    byName.set(name, versions);
    const needs = new Map();
    const container = name.startsWith("@") ? join(dir, "..", "..") : join(dir, "..");
    let entries = [];
    try {
      entries = readdirSync(container);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry === ".bin" || entry === ".pnpm") continue;
      const full = join(container, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (entry.startsWith("@")) {
        if (!stat.isDirectory()) continue; // a scope dir holding a symlink is listed under its children
        let children = [];
        try {
          children = readdirSync(full);
        } catch {
          children = [];
        }
        for (const child of children) {
          const target = join(full, child);
          let targetStat;
          try {
            targetStat = lstatSync(target);
          } catch {
            continue;
          }
          if (!targetStat.isSymbolicLink()) continue;
          const resolved = realpathSync(target);
          needs.set(entry + "/" + child, versionOf(resolved));
          queue.push(resolved);
        }
      } else if (stat.isSymbolicLink()) {
        const resolved = realpathSync(full);
        needs.set(entry, versionOf(resolved));
        queue.push(resolved);
      }
    }
    consumerNeeds.set(dir, needs);
  }
  return { byName, consumerNeeds };
}

export function stageDshRuntime(root, platform, arch) {
  const version = pinnedDshVersion(root);
  const { byName, consumerNeeds } = pnpmClosure(root, DSH_PACKAGE);
  const entryDir = realpathSync(join(root, "node_modules", ...DSH_PACKAGE.split("/")));
  const entryNeeds = consumerNeeds.get(entryDir);
  if (!entryNeeds) {
    throw new Error(`Could not resolve ${DSH_PACKAGE} from ${root}`);
  }
  const installedVersions = byName.get(DSH_PACKAGE) ?? new Map();
  if (!installedVersions.get(version)) {
    const have = [...installedVersions.keys()].join(", ");
    throw new Error(`node_modules has ${DSH_PACKAGE}@${have || "nothing"}; package.json pins ${version}`);
  }
  const excluded = new Set();
  for (const name of byName.keys()) {
    if (name.includes("libreoffice-kit") || !matchesTarget(platformVariantOf(name), platform, arch)) {
      excluded.add(name);
    }
  }
  const outDir = stagedDshDirectory(root, platform, arch);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // Top level per name: what the entry package resolves itself, else the most
  // referenced version, else the highest; a non-top version nests under its
  // consumer so both resolve.
  const usage = new Map(); // "name@version" -> consumer count
  for (const needs of consumerNeeds.values()) {
    for (const [name, depVersion] of needs) {
      const key = name + "@" + depVersion;
      usage.set(key, (usage.get(key) ?? 0) + 1);
    }
  }
  const topVersion = new Map(); // name -> physical dir
  for (const [name, versions] of byName) {
    if (excluded.has(name)) continue;
    let chosen;
    if (versions.size === 1) {
      chosen = versions.values().next().value;
    } else {
      let winner = entryNeeds.get(name) ?? null;
      if (!winner) {
        let best = -1;
        for (const v of versions.keys()) {
          const count = usage.get(name + "@" + v) ?? 0;
          if (count > best) {
            best = count;
            winner = v;
          }
        }
      }
      if (!winner) {
        winner = [...versions.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[versions.size - 1];
      }
      chosen = versions.get(winner);
    }
    topVersion.set(name, chosen);
  }
  for (const [name, dir] of topVersion) {
    const target = join(outDir, "node_modules", ...name.split("/"));
    mkdirSync(target, { recursive: true });
    cpSync(dir, target, { recursive: true });
  }
  // node-pty ships prebuilds for every platform; only the target's loads.
  const nodePtyPrebuilds = join(outDir, "node_modules", "node-pty/prebuilds");
  if (topVersion.has("node-pty") && existsSync(nodePtyPrebuilds)) {
    for (const dir of readdirSync(nodePtyPrebuilds)) {
      if (dir !== `${platform}-${arch}`) {
        rmSync(join(nodePtyPrebuilds, dir), { recursive: true, force: true });
      }
    }
  }
  for (const [consumerDir, needs] of consumerNeeds) {
    const consumerName = packageNameOf(consumerDir);
    if (topVersion.get(consumerName) !== consumerDir) continue; // only top-staged consumers nest
    for (const [depName, depVersion] of needs) {
      const topDir = topVersion.get(depName);
      const needDir = (byName.get(depName) ?? new Map()).get(depVersion);
      if (!needDir || needDir === topDir) continue; // the top copy already satisfies it
      const nestTarget = join(outDir, "node_modules", ...consumerName.split("/"), "node_modules", ...depName.split("/"));
      mkdirSync(nestTarget, { recursive: true });
      cpSync(needDir, nestTarget, { recursive: true });
    }
  }
  // dsh-subprocess-local's postinstall is skipped by the repo's build-script
  // policy; its spawn helper is plain JS, so ensure it here, once, on the
  // staged tree.
  const subprocessName = "@deepseek-ai/dsh-subprocess-local";
  const subprocessDir = topVersion.get(subprocessName);
  if (subprocessDir) {
    const helper = join(outDir, "node_modules", subprocessName, "scripts/ensure-spawn-helper.mjs");
    if (existsSync(helper)) {
      execFileSync(process.execPath, ["scripts/ensure-spawn-helper.mjs"], {
        cwd: join(outDir, "node_modules", subprocessName),
        stdio: "pipe",
      });
    }
  }
  const entry = join(outDir, "node_modules", DSH_PACKAGE, "lib", "bin.js");
  if (!existsSync(entry)) {
    throw new Error(`Staged tree lost its entry point: ${entry}`);
  }
  const probe = execFileSync(process.execPath, [entry, "--version"], { stdio: "pipe" }).toString();
  if (!probe.includes(version)) {
    throw new Error(`Staged runtime answered "${probe.trim()}", expected ${version}`);
  }
  return { outDir, entry, packages: topVersion.size, version };
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { outDir, packages, version } = stageDshRuntime(root, process.platform, process.arch);
  console.log(`dsh runtime ${version} staged: ${packages} packages -> ${relative(root, outDir)}`);
}