import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARCHITECTURES = {
  arm64: "arm64-v8a",
  universal: "armeabi-v7a,arm64-v8a,x86,x86_64",
};

const args = process.argv.slice(2);
let target = "arm64";
let outPath = null;
let maxWorkers = "2";
let skipDeps = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--target") {
    target = args[++i];
  } else if (arg === "--out") {
    outPath = args[++i];
  } else if (arg === "--max-workers") {
    maxWorkers = args[++i];
  } else if (arg === "--skip-deps") {
    skipDeps = true;
  } else if (!arg.startsWith("-")) {
    target = arg;
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}

const architectures = ARCHITECTURES[target];
if (!architectures) {
  throw new Error(`Unknown APK target: ${target}. Use arm64 or universal.`);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const appDir = path.join(root, "packages/app");
const appPkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));

const signingDir =
  process.env.PASEO_ANDROID_SIGNING_DIR ?? path.join(os.homedir(), ".config/paseo-android-signing");
const keystorePath =
  process.env.PASEO_ANDROID_SIGNING_KEYSTORE ?? path.join(signingDir, "paseo-fork.keystore");
const passwordFilePath =
  process.env.PASEO_ANDROID_SIGNING_PASSWORD_FILE ?? path.join(signingDir, "keystore.password");
const keyAlias = process.env.PASEO_ANDROID_SIGNING_KEY_ALIAS ?? "paseo-fork";

if (!existsSync(keystorePath)) {
  throw new Error(`Android signing keystore not found at ${keystorePath}`);
}
if (!existsSync(passwordFilePath)) {
  throw new Error(`Android signing password file not found at ${passwordFilePath}`);
}

const env = {
  ...process.env,
  APP_VARIANT: process.env.APP_VARIANT ?? "fork",
  CI: "1",
  EXPO_NO_TELEMETRY: "1",
  CMAKE_BUILD_PARALLEL_LEVEL: process.env.CMAKE_BUILD_PARALLEL_LEVEL ?? "4",
  PASEO_ANDROID_SIGNING_KEYSTORE: keystorePath,
  PASEO_ANDROID_SIGNING_PASSWORD_FILE: passwordFilePath,
  PASEO_ANDROID_SIGNING_KEY_ALIAS: keyAlias,
};
delete env.PASEO_WATCHDOG_BUILD;
delete env.PASEO_PROFILE_BUILD;
delete env.PASEO_FDROID_BUILD;

function run(command, commandArgs, cwd, extraEnv = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const skiaDir = path.join(appDir, "node_modules/@shopify/react-native-skia");
if (existsSync(skiaDir) && !existsSync(path.join(skiaDir, "libs/android"))) {
  run("node", ["scripts/install-libs.js"], skiaDir);
}

const enrichedMarkdownDir = path.join(appDir, "node_modules/react-native-enriched-markdown");
if (
  existsSync(enrichedMarkdownDir) &&
  !existsSync(path.join(enrichedMarkdownDir, "cpp/highlight/vendor/tree-sitter/src"))
) {
  run("node", ["postinstall.mjs"], enrichedMarkdownDir, { INIT_CWD: appDir });
}

if (!skipDeps) {
  run("npm", ["run", "generate:validators", "--workspace=@getpaseo/protocol"], root);
  run("npm", ["run", "build:app-deps"], root);
}

run("npx", ["expo", "prebuild", "--platform", "android", "--clean"], appDir);

const gradleArgs = [
  ":app:assembleRelease",
  "-x",
  "lint",
  "-x",
  "lintVitalAnalyzeRelease",
  "-x",
  "lintVitalRelease",
  "-x",
  "generateReleaseLintModel",
  "-x",
  "generateReleaseLintVitalModel",
  "--no-daemon",
  `--max-workers=${maxWorkers}`,
  "-Dorg.gradle.parallel=false",
  `-PreactNativeArchitectures=${architectures}`,
];

if (env.PASEO_ANDROID_AAPT2_OVERRIDE) {
  gradleArgs.push(`-Pandroid.aapt2FromMavenOverride=${env.PASEO_ANDROID_AAPT2_OVERRIDE}`);
}

run("./gradlew", gradleArgs, path.join(appDir, "android"));

const destination = outPath
  ? path.resolve(root, outPath)
  : path.join(root, `artifacts/paseo-fork-${appPkg.version}-${target}.apk`);
mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(
  path.join(appDir, "android/app/build/outputs/apk/release/app-release.apk"),
  destination,
);

console.log(`\nSigned fork release APK: ${destination}`);
console.log(`Variant: ${env.APP_VARIANT} | Target: ${target} (${architectures})`);
console.log(`Keystore: ${keystorePath} (alias: ${keyAlias})\n`);
