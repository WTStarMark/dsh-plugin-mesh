/**
 * API 的 meshPath 作用域：同一套缓存根目录，可以指向插件图 mesh；默认仍读完整 mesh。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../tools/api.mjs";

const node = (id, category = "agent") => ({
  id, name: id.split("/")[1], owner: id.split("/")[0], stars: 1, description: "desc", topics: [], matchedTags: [], category, categoryLabel: category,
});

test("createApi 的 meshPath 只影响读哪份 mesh，不影响缓存根目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-api-scope-"));
  try {
    await mkdir(join(root, "data"), { recursive: true });
    await mkdir(join(root, "plugin"), { recursive: true });
    await writeFile(join(root, "data", "mesh.json"), JSON.stringify({ meta: {}, nodes: [node("a/1"), node("a/2")], edges: [], clusters: [], tags: [], hubs: [] }));
    await writeFile(join(root, "plugin", "mesh.json"), JSON.stringify({ meta: {}, nodes: [node("a/1")], edges: [], clusters: [], tags: [], hubs: [] }));
    const full = createApi({ root });
    const scoped = createApi({ root, meshPath: "plugin/mesh.json" });
    assert.equal((await full.categories()).total, 2);
    assert.equal((await scoped.categories()).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
