import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("production build contains the Xiaopen Hub console", async () => {
  const html = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /<title>小喷 Hub · 本地模型控制台<\/title>/i);
  assert.doesNotMatch(html, /vinext|cloudflare|Your site is taking shape/i);

  const assetsDir = new URL("../dist/assets/", import.meta.url);
  const scripts = (await readdir(assetsDir)).filter((name) => name.endsWith(".js"));
  assert.ok(scripts.length > 0, "expected a compiled JavaScript asset");
  const bundle = await readFile(join(assetsDir.pathname, scripts[0]), "utf8");
  assert.match(bundle, /模型服务/);
  assert.match(bundle, /API Key/);
  assert.match(bundle, /设备网关/);
  assert.doesNotMatch(bundle, /Xiaozhi|小智/);
});
