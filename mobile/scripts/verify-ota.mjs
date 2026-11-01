import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const response = await fetch("https://u.expo.dev/64ff7f40-aee0-4ef3-b3f4-4695e935bdf0", {
  headers: { "Accept": "multipart/mixed,application/expo+json,application/json",
    "expo-platform": "android", "expo-runtime-version": "1.1.0",
    "expo-channel-name": "preview", "expo-protocol-version": "1", "expo-api-version": "1",
    "expo-updates-environment": "BARE", "expo-json-error": "true" }
});
assert.equal(response.status, 200);
const contentType = response.headers.get("content-type") ?? "";
assert.ok(contentType.includes("multipart/") || contentType.includes("json"), "Unsupported native OTA content type");
const text = await response.text();
let manifest;
let extensions = {};
if (contentType.includes("multipart/") || text.startsWith("--")) {
  const boundary = /boundary="?([^";]+)/i.exec(contentType)?.[1] ?? text.split(/\r?\n/, 1)[0].slice(2);
  assert.ok(boundary, "Missing multipart boundary");
  const parts = text.split(`--${boundary}`);
  const parsePart = name => {
    const part = parts.find(value => value.includes(`name="${name}"`));
    if (!part) return undefined;
    const separator = /\r?\n\r?\n/.exec(part);
    assert.ok(separator, "Missing multipart body");
    return JSON.parse(part.slice(separator.index + separator[0].length).trim());
  };
  manifest = parsePart("manifest");
  assert.ok(manifest, "Missing manifest part");
  extensions = parsePart("extensions") ?? {};
} else manifest = JSON.parse(text);
assert.equal(manifest.runtimeVersion, "1.1.0");
const expectedUpdateId = process.argv[2];
if (expectedUpdateId) assert.equal(manifest.id, expectedUpdateId);
assert.ok(manifest.launchAsset?.url);
// Native Expo Updates applies these scoped asset authorization headers too.
// Do not print their values or persist them in the handoff files.
const assetResponse = await fetch(manifest.launchAsset.url, { headers: {
  ...extensions.assetRequestHeaders?.[manifest.launchAsset.key],
  "Accept": "*/*", "Expo-Platform": "android", "Expo-Protocol-Version": "1",
  "Expo-API-Version": "1", "Expo-Updates-Environment": "BARE", "Expo-Runtime-Version": "1.1.0",
  "expo-channel-name": "preview"
} });
assert.equal(assetResponse.status, 200);
const asset = Buffer.from(await assetResponse.arrayBuffer());
assert.equal(createHash("sha256").update(asset).digest("base64url"), manifest.launchAsset.hash);
console.log(JSON.stringify({ verified: true, channel: "preview", runtime: manifest.runtimeVersion,
  updateId: manifest.id, launchAssetAvailable: true, bundleBytes: asset.length, bundleHashVerified: true }));
