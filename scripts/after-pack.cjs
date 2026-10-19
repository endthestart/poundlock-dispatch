// Electron's own license and Chromium's notices ship with every package.
// electron-builder leaves them out of a macOS app, so they are copied from the
// installed `electron` package, after checking it is the release being packaged.
const { copyFileSync, existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

module.exports = async function afterPack(context) {
  const electron = dirname(require.resolve("electron/package.json"));
  const expected = require("electron/package.json").version;
  const dist = join(electron, "dist");
  const version = existsSync(join(dist, "version")) ? readFileSync(join(dist, "version"), "utf8").trim() : "";
  if (version !== expected)
    throw new Error(
      `node_modules/electron/dist is ${version || "missing"}, not Electron ${expected}: run \`node node_modules/electron/install.js\``,
    );
  const resources =
    context.electronPlatformName === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : context.appOutDir;
  copyFileSync(join(dist, "LICENSE"), join(resources, "LICENSE.electron.txt"));
  copyFileSync(join(dist, "LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html"));
};
