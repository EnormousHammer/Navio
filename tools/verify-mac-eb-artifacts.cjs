/**
 * After `npm run dist:mac`, assert electron-builder wrote the expected DMG + portable ZIP
 * names (derived from package.json "version" + electron-builder.yml templates).
 */
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const v = pkg.version;

/** Prefer explicit env (CI); else dist-eb; else dist-eb-mac-build after dist:mac:nolock. */
function resolveOutDir() {
  const fromEnv = process.env.NAVIO_DIST_EB && path.resolve(root, process.env.NAVIO_DIST_EB);
  const candidates = [fromEnv, path.join(root, "dist-eb"), path.join(root, "dist-eb-mac-build")].filter(
    (p, i, a) => p && a.indexOf(p) === i,
  );
  const names = [
    `Navio-macOS-${v}-arm64.dmg`,
    `Navio-macOS-${v}-x64.dmg`,
    `Navio-macPortable-${v}-arm64.zip`,
    `Navio-macPortable-${v}-x64.zip`,
  ];
  for (const dir of candidates) {
    let ok = true;
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (!fs.statSync(p).isFile()) {
          ok = false;
        }
      } catch {
        ok = false;
      }
    }
    if (ok) {
      return dir;
    }
  }
  return null;
}

const required = [
  `Navio-macOS-${v}-arm64.dmg`,
  `Navio-macOS-${v}-x64.dmg`,
  `Navio-macPortable-${v}-arm64.zip`,
  `Navio-macPortable-${v}-x64.zip`,
];

function main() {
  const out = resolveOutDir();
  if (out == null) {
    console.error(
      "::error::No directory contains all four mac artifacts (dist-eb / dist-eb-mac-build / NAVIO_DIST_EB).",
    );
    process.exit(1);
  }
  if (!fs.existsSync(out)) {
    console.error(`::error::Missing output directory: ${out}`);
    process.exit(1);
  }
  const missing = [];
  for (const name of required) {
    const p = path.join(out, name);
    try {
      if (!fs.statSync(p).isFile()) {
        missing.push(name);
      }
    } catch {
      missing.push(name);
    }
  }
  if (missing.length) {
    console.error("::error::Expected mac electron-builder artifacts missing:");
    for (const m of missing) {
      console.error("  -", m);
    }
    let listed = "(could not read dist-eb)";
    try {
      listed = fs
        .readdirSync(out)
        .filter((n) => !n.startsWith("."))
        .join("\n");
    } catch (_) {
      /* ignore */
    }
    console.error(`Output dir ${out} contents:\n` + listed);
    process.exit(1);
  }
  console.log("OK: mac electron-builder artifacts for", v);
}

main();
