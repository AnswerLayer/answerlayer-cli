import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(packageJsonUrl, "utf8"));

test("npm package exposes both CLI executables", () => {
  assert.deepEqual(packageJson.bin, {
    answerlayer: "bin/answerlayer.js",
    al: "bin/answerlayer.js",
  });
});
