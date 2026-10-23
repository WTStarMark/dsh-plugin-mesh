/**
 * 子目录归属校验的单元测试（全部注入 fetchImpl，不联网）。
 *
 * 这些用例盯的是"不许猜"那几条线：
 *  · 自述目录是本地路径（.dsh/…）直接驳回，不发请求；
 *  · 目录不存在（404）驳回；目录存在但 package.json 名字对不上，只算未核实、不算驳回；
 *  · 网络失败沿用缓存里的旧结论，别把一次断网记成一周的"不存在"；
 *  · 缓存命中不再发请求，过期才重查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideEntryAttribution } from "../tools/market-index.mjs";
import {
  VERDICT,
  createGitHubCodeSearchFetcher,
  createGitHubCommitFetcher,
  createGitHubDirectoryHistoryFetcher,
  classifyRepositoryDirectory,
  judgeSubdirCheck,
  repoDirCacheKey,
  loadGitHubToken,
  createGitHubPackageJsonFetcher,
  readRepoDirCache,
  writeRepoDirCache,
  runSubdirVerification,
} from "../tools/repo-dir-verify.mjs";

const BS = String.fromCharCode(92);

test("本地路径识别：.dsh/ 等一律按本地路径，不能当仓库目录", () => {
  assert.deepEqual(classifyRepositoryDirectory("").kind, "absent");
  assert.deepEqual(classifyRepositoryDirectory(null).kind, "absent");
  assert.deepEqual(classifyRepositoryDirectory("  ").kind, "absent");
  assert.deepEqual(classifyRepositoryDirectory(".dsh/plugins/dsh-ab-ocr"), { kind: "local", reason: "dsh-home-path" });
  assert.deepEqual(classifyRepositoryDirectory("./.dsh/plugins/x"), { kind: "local", reason: "dsh-home-path" });
  assert.deepEqual(classifyRepositoryDirectory(".dsh"), { kind: "local", reason: "dsh-home-path" });
  assert.deepEqual(classifyRepositoryDirectory("/home/me/repo/pkg"), { kind: "local", reason: "absolute-path" });
  assert.deepEqual(classifyRepositoryDirectory("~/plugins/x"), { kind: "local", reason: "home-path" });
  assert.deepEqual(classifyRepositoryDirectory("C:" + BS + "repo" + BS + "pkg"), { kind: "local", reason: "windows-absolute" });
  assert.deepEqual(classifyRepositoryDirectory("../outside"), { kind: "local", reason: "parent-escape" });
  assert.deepEqual(classifyRepositoryDirectory("packages" + BS + "x"), { kind: "local", reason: "backslash-path" });
});

test("仓库内相对路径照常放行（packages/skill/... 这类官方单仓结构）", () => {
  for (const dir of ["packages/skill/skill-filesystem", "./packages/x", "apps/cli", "packages/session-query/session-history-lite/"]) {
    assert.deepEqual(classifyRepositoryDirectory(dir), { kind: "repo", reason: null }, dir);
  }
});

test("三档判定：只有目录里 package.json 的 name 对得上才算确证", () => {
  assert.deepEqual(judgeSubdirCheck(null, "pkg"), { verdict: VERDICT.UNVERIFIED, reason: "not-checked" });
  assert.equal(judgeSubdirCheck({ state: "verified", name: "pkg" }, "pkg").verdict, VERDICT.CONFIRMED);
  assert.equal(judgeSubdirCheck({ state: "verified", name: "PKG" }, "pkg").verdict, VERDICT.CONFIRMED, "包名比较大小写不敏感");
  assert.equal(judgeSubdirCheck({ state: "verified", name: "other" }, "pkg").verdict, VERDICT.UNVERIFIED, "名字对不上只算未核实");
  assert.equal(judgeSubdirCheck({ state: "verified", name: null }, "pkg").verdict, VERDICT.UNVERIFIED);
  assert.equal(judgeSubdirCheck({ state: "missing" }, "pkg").verdict, VERDICT.REFUTED, "目录不存在且历史里也没有 = 驳回");
  assert.equal(judgeSubdirCheck({ state: "moved" }, "pkg").verdict, VERDICT.UNVERIFIED, "目录后来搬走 = 只算未核实");
  assert.equal(judgeSubdirCheck({ state: "local", reason: "dsh-home-path" }, "pkg").verdict, VERDICT.REFUTED);
  assert.equal(judgeSubdirCheck({ state: "error", reason: "rate-limited" }, "pkg").verdict, VERDICT.UNVERIFIED, "限流不当否定");
});

test("缓存 key：仓库名小写、目录去掉开头 ./ 与结尾 /", () => {
  assert.equal(repoDirCacheKey("Deepseek-AI/DeepSeek-Harness", "./packages/x/"), "deepseek-ai/deepseek-harness#packages/x");
});

/** 造一个假 fetch：resolver(url, init) -> {status, text?, headers?} */
function fakeFetch(resolver) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization ?? null });
    const out = resolver(url);
    if (out instanceof Error) throw out;
    return {
      status: out.status,
      text: async () => out.text ?? "",
      headers: { get: (name) => (name.toLowerCase() === "x-ratelimit-remaining" ? (out.remaining ?? null) : null) },
    };
  };
  return { fetchImpl, calls };
}

test("GitHub 取数：200 取 name、404 记不存在、限流/坏 JSON 不当不存在", async () => {
  const ok = createGitHubPackageJsonFetcher({ token: "t", fetchImpl: fakeFetch(() => ({ status: 200, text: '{"name":"@scope/pkg","version":"1.2.3","repository":"git+https://github.com/a/b.git"}' })).fetchImpl, sleepFn: async () => {} });
  const okOut = await ok("a/b", "packages/x");
  assert.equal(okOut.state, "verified");
  assert.equal(okOut.name, "@scope/pkg");
  assert.equal(okOut.version, "1.2.3");
  assert.equal(okOut.repository, "git+https://github.com/a/b.git");
  const missing = createGitHubPackageJsonFetcher({ fetchImpl: fakeFetch(() => ({ status: 404 })).fetchImpl, sleepFn: async () => {} });
  assert.deepEqual(await missing("a/b", "packages/gone"), { state: "missing" });
  const limited = createGitHubPackageJsonFetcher({ fetchImpl: fakeFetch(() => ({ status: 403, remaining: "0" })).fetchImpl, sleepFn: async () => {} });
  assert.deepEqual(await limited("a/b", "packages/x"), { state: "error", reason: "rate-limited" });
  const bad = createGitHubPackageJsonFetcher({ fetchImpl: fakeFetch(() => ({ status: 200, text: "not json" })).fetchImpl, sleepFn: async () => {} });
  assert.deepEqual(await bad("a/b", "packages/x"), { state: "error", reason: "bad-json" });
  const flaky = createGitHubPackageJsonFetcher({
    fetchImpl: fakeFetch(() => (calls++ === 0 ? { status: 500 } : { status: 200, text: '{"name":"p"}' })).fetchImpl,
    sleepFn: async () => {},
  });
  let calls = 0;
  const flakyOut = await flaky("a/b", "packages/x");
  assert.equal(flakyOut.state, "verified", "5xx 重试一次");
  assert.equal(flakyOut.name, "p");
  const down = createGitHubPackageJsonFetcher({ fetchImpl: fakeFetch(() => new Error("ECONNRESET")).fetchImpl, sleepFn: async () => {} });
  assert.equal((await down("a/b", "packages/x")).state, "error", "网络异常记 error，不是 missing");
});

test("令牌：进程环境优先，其次 .env；读不到返回 null，不打印内容", () => {
  assert.equal(loadGitHubToken({ env: { GITHUB_TOKEN: " from-env " } }), "from-env");
  const dir = mkdtempSync(join(tmpdir(), "repo-dir-verify-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, "# 注释\nOTHER=1\nexport GH_TOKEN='ghp_test'\n");
    assert.equal(loadGitHubToken({ env: {}, envFile: file }), "ghp_test");
    assert.equal(loadGitHubToken({ env: {}, envFile: join(dir, "missing.env") }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("批量校验：本地路径不发请求、404 驳回、名字不符未核实、结果进缓存", async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.includes("/repos/a/mono/contents/packages/live/package.json")) return { status: 200, text: '{"name":"pkg-live"}' };
    if (url.includes("/repos/a/mono/contents/packages/gone/package.json")) return { status: 404 };
    if (url.includes("/repos/b/other/contents/packages/renamed/package.json")) return { status: 200, text: '{"name":"something-else"}' };
    return { status: 404 };
  });
  const targets = [
    { pkg: "pkg-local", repoKey: "deepseek-ai/deepseek-harness", directory: ".dsh/plugins/pkg-local" },
    { pkg: "pkg-live", repoKey: "a/mono", directory: "packages/live" },
    { pkg: "pkg-gone", repoKey: "a/mono", directory: "packages/gone" },
    { pkg: "pkg-renamed", repoKey: "b/other", directory: "packages/renamed" },
    { pkg: "no-dir", repoKey: "a/mono", directory: "" },
  ];
  const fetcher = createGitHubPackageJsonFetcher({ fetchImpl, sleepFn: async () => {} });
  const first = await runSubdirVerification({ targets, cache: null, fetchPackageJson: fetcher, now: 1_000_000, concurrency: 2 });
  assert.equal(calls.length, 3, "本地路径/无目录不发请求");
  assert.equal(first.stats.local, 1);
  assert.equal(judgeSubdirCheck(first.results.get("pkg-local"), "pkg-local").verdict, VERDICT.REFUTED);
  assert.equal(judgeSubdirCheck(first.results.get("pkg-live"), "pkg-live").verdict, VERDICT.CONFIRMED);
  assert.equal(judgeSubdirCheck(first.results.get("pkg-gone"), "pkg-gone").verdict, VERDICT.REFUTED);
  assert.equal(judgeSubdirCheck(first.results.get("pkg-renamed"), "pkg-renamed").verdict, VERDICT.UNVERIFIED);
  assert.equal(first.results.has("no-dir"), false, "没写目录的 target 保持调用方原有逻辑");

  const second = await runSubdirVerification({ targets, cache: first.cache, fetchPackageJson: fetcher, now: 1_000_000 + 1000 });
  assert.equal(calls.length, 3, "缓存命中不再发请求");
  assert.equal(second.stats.cached + second.stats.local, 4);

  const third = await runSubdirVerification({ targets, cache: first.cache, fetchPackageJson: fetcher, now: 1_000_000 + 8 * 24 * 3600 * 1000 });
  assert.ok(calls.length > 3, "缓存过期后重查");
});

test("请求失败沿用缓存旧结论：断网不能把已确证的包打成不存在", async () => {
  const first = await runSubdirVerification({
    targets: [{ pkg: "pkg", repoKey: "a/b", directory: "packages/x" }],
    cache: null,
    fetchPackageJson: async () => ({ state: "verified", name: "pkg" }),
    now: 1_000_000,
  });
  const failing = async () => {
    throw new Error("offline");
  };
  const second = await runSubdirVerification({
    targets: [{ pkg: "pkg", repoKey: "a/b", directory: "packages/x" }],
    cache: first.cache,
    fetchPackageJson: failing,
    now: 1_000_000 + 8 * 24 * 3600 * 1000, // 缓存已过期，仍然要沿用旧结论
  });
  assert.equal(judgeSubdirCheck(second.results.get("pkg"), "pkg").verdict, VERDICT.CONFIRMED);
  assert.equal(second.stats.errors, 1);
});

test("缓存读写：原子替换、坏文件按空表处理", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-dir-cache-"));
  try {
    const file = join(dir, "nested", "repo-dirs.json");
    writeRepoDirCache(file, { entries: { "a/b#packages/x": { state: "missing", at: new Date(0).toISOString() } } });
    const back = readRepoDirCache(file);
    assert.equal(back.entries["a/b#packages/x"].state, "missing");
    writeFileSync(file, "{not json");
    assert.deepEqual(readRepoDirCache(file).entries, {}, "坏文件不能把索引生成搞崩");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("目录搬走 vs 从未存在：历史有提交算未核实，历史空才驳回", async () => {
  const history = createGitHubDirectoryHistoryFetcher({
    fetchImpl: fakeFetch((url) => (url.includes("path=packages/moved") ? { status: 200, text: "[{\"sha\":\"x\"}]" } : { status: 200, text: "[]" })).fetchImpl,
    sleepFn: async () => {},
  });
  assert.deepEqual(await history("a/b", "packages/moved"), { state: "history" });
  assert.deepEqual(await history("a/b", "packages/never"), { state: "none" });
  const gone = createGitHubDirectoryHistoryFetcher({ fetchImpl: fakeFetch(() => ({ status: 404 })).fetchImpl, sleepFn: async () => {} });
  assert.equal((await gone("a/b", "packages/x")).state, "error", "仓库没了/路径查不了 = 拿不到结论");

  const pkgFetcher = async (_repoKey, directory) => (directory === "packages/moved" ? { state: "missing" } : { state: "missing" });
  const out = await runSubdirVerification({
    targets: [
      { pkg: "pkg-moved", repoKey: "a/b", directory: "packages/moved" },
      { pkg: "pkg-never", repoKey: "a/b", directory: "packages/never" },
    ],
    cache: null,
    fetchPackageJson: pkgFetcher,
    fetchDirectoryHistory: history,
    now: 2_000_000,
  });
  assert.equal(judgeSubdirCheck(out.results.get("pkg-moved"), "pkg-moved").verdict, VERDICT.UNVERIFIED);
  assert.equal(judgeSubdirCheck(out.results.get("pkg-never"), "pkg-never").verdict, VERDICT.REFUTED);
  assert.equal(out.stats.moved, 1);
  assert.equal(out.stats.missing, 1);
});

test("缓存清理：90 天没再出现的结论删掉，活跃的保留", async () => {
  const now = 5_000_000_000;
  const old = new Date(now - 120 * 24 * 3600 * 1000).toISOString();
  const fresh = new Date(now - 24 * 3600 * 1000).toISOString();
  const out = await runSubdirVerification({
    targets: [],
    cache: {
      entries: {
        "a/b#packages/old": { state: "missing", at: old },
        "a/b#packages/fresh": { state: "missing", at: fresh },
      },
    },
    fetchPackageJson: async () => ({ state: "missing" }),
    now,
  });
  assert.equal(out.cache.entries["a/b#packages/old"], undefined);
  assert.equal(out.cache.entries["a/b#packages/fresh"].state, "missing");
});

test("没有目录声明的包：code search + gitHead 三档判定", async () => {
  const search = createGitHubCodeSearchFetcher({
    fetchImpl: fakeFetch((url) =>
      url.includes("search%2Fcode") || url.includes("search/code")
        ? { status: 200, text: '{"items":[{"path":"packages/x/package.json"}]}' }
        : { status: 404 },
    ).fetchImpl,
    sleepFn: async () => {},
    minIntervalMs: 0,
  });
  assert.deepEqual(await search("a/b", "@linxin666/dsh-remote-web-ui"), { state: "found", path: "packages/x/package.json", paths: ["packages/x/package.json"] });
  const empty = createGitHubCodeSearchFetcher({ fetchImpl: fakeFetch(() => ({ status: 200, text: '{"items":[]}' })).fetchImpl, sleepFn: async () => {}, minIntervalMs: 0 });
  assert.deepEqual(await empty("a/b", "fake-pkg"), { state: "none" });
  const limited = createGitHubCodeSearchFetcher({ fetchImpl: fakeFetch(() => ({ status: 403, remaining: "0" })).fetchImpl, sleepFn: async () => {}, minIntervalMs: 0 });
  assert.equal((await limited("a/b", "x")).state, "error");

  const commit = createGitHubCommitFetcher({
    fetchImpl: fakeFetch((url) => (url.endsWith("/commits/abc123") ? { status: 200, text: "{}" } : { status: 422 })).fetchImpl,
    sleepFn: async () => {},
  });
  assert.deepEqual(await commit("a/b", "abc123"), { state: "exists" });
  assert.deepEqual(await commit("a/b", "deadbeef"), { state: "missing" });

  // found + package.json name 对得上 -> 确证
  const pkgFetcher = async (repoKey, dir) => (dir === "packages/x" ? { state: "verified", name: "@linxin666/dsh-remote-web-ui" } : { state: "missing" });
  const found = await runSubdirVerification({
    targets: [{ pkg: "@linxin666/dsh-remote-web-ui", repoKey: "zhu1090093659/dsh-web", directory: "", gitHead: null, publisher: "linxin666" }],
    cache: null,
    fetchPackageJson: pkgFetcher,
    fetchCodeSearch: async () => ({ state: "found", path: "packages/x/package.json" }),
    fetchCommitExists: async () => ({ state: "missing" }),
    now: 3_000_000,
  });
  assert.equal(judgeSubdirCheck(found.results.get("@linxin666/dsh-remote-web-ui"), "@linxin666/dsh-remote-web-ui").verdict, VERDICT.CONFIRMED);

  // 多命中：第一个是聚合包（name 对不上），第二个才是它自己的 package.json -> 应该确认第二个
  const multi = await runSubdirVerification({
    targets: [{ pkg: "@linxin666/dsh-client-ui-task-board", repoKey: "zhu1090093659/dsh-web", directory: "", gitHead: null, publisher: "linxin666" }],
    cache: null,
    fetchPackageJson: async (repoKey, dir) => (dir === "packages/dsh-web-all" ? { state: "verified", name: "@linxin666/dsh-web-all" } : { state: "verified", name: "@linxin666/dsh-client-ui-task-board" }),
    fetchCodeSearch: async () => ({ state: "found", paths: ["packages/dsh-web-all/package.json", "packages/dsh-task-board/package.json"], path: "packages/dsh-web-all/package.json" }),
    fetchCommitExists: async () => ({ state: "missing" }),
    now: 3_000_000,
  });
  const multiEntry = multi.results.get("@linxin666/dsh-client-ui-task-board");
  assert.equal(multiEntry.state, "verified");
  assert.equal(multiEntry.directory, "packages/dsh-task-board");

  // 搜不到 + 发布者不是仓库主人 + gitHead 不在仓库 -> 驳回（dsh-market-plus 这类）
  const fake = await runSubdirVerification({
    targets: [{ pkg: "dsh-market-plus", repoKey: "dsh-market/dsh-market", directory: "", gitHead: "28156107", publisher: "owltechcode" }],
    cache: null,
    fetchPackageJson: async () => ({ state: "missing" }),
    fetchCodeSearch: async () => ({ state: "none" }),
    fetchCommitExists: async () => ({ state: "missing" }),
    now: 3_000_000,
  });
  assert.equal(judgeSubdirCheck(fake.results.get("dsh-market-plus"), "dsh-market-plus").verdict, VERDICT.REFUTED);

  // 搜不到但发布账号是仓库主人（或 CI 发布）：只算未核实，不驳回
  const sameOwner = await runSubdirVerification({
    targets: [{ pkg: "own-pkg", repoKey: "a/b", directory: "", gitHead: null, publisher: "a" }],
    cache: null,
    fetchPackageJson: async () => ({ state: "missing" }),
    fetchCodeSearch: async () => ({ state: "none" }),
    fetchCommitExists: async () => ({ state: "missing" }),
    now: 3_000_000,
  });
  assert.equal(judgeSubdirCheck(sameOwner.results.get("own-pkg"), "own-pkg").verdict, VERDICT.UNVERIFIED);
  const ci = await runSubdirVerification({
    targets: [{ pkg: "ci-pkg", repoKey: "a/b", directory: "", gitHead: "abc", publisher: "GitHub Actions" }],
    cache: null,
    fetchPackageJson: async () => ({ state: "missing" }),
    fetchCodeSearch: async () => ({ state: "none" }),
    fetchCommitExists: async () => ({ state: "exists" }),
    now: 3_000_000,
  });
  assert.equal(judgeSubdirCheck(ci.results.get("ci-pkg"), "ci-pkg").verdict, VERDICT.UNVERIFIED);

  // code search 拿不到结论（限流）-> 未核实，不驳回
  const err = await runSubdirVerification({
    targets: [{ pkg: "err-pkg", repoKey: "a/b", directory: "", gitHead: null, publisher: "x" }],
    cache: null,
    fetchPackageJson: async () => ({ state: "missing" }),
    fetchCodeSearch: async () => ({ state: "error", reason: "rate-limited" }),
    fetchCommitExists: async () => ({ state: "missing" }),
    now: 3_000_000,
  });
  assert.equal(judgeSubdirCheck(err.results.get("err-pkg"), "err-pkg").verdict, VERDICT.UNVERIFIED);
});

test("索引署名策略：驳回的子目录声明不许外借仓库身份", () => {
  const node = { id: "deepseek-ai/deepseek-harness", name: "deepseek-harness", owner: "deepseek-ai", stars: 257512, avatar: "https://x/a.png" };
  const resolvedOk = { verified: true, owner: "deepseek-ai", node };
  const chosenSubdir = { subdir: true, downloads: 137 };

  const refuted = decideEntryAttribution({
    node,
    resolved: resolvedOk,
    chosen: chosenSubdir,
    check: { verdict: "refuted", reason: "directory-missing" },
  });
  assert.equal(refuted.identity, null, "驳回后不许再用官方仓库的标题/头像/星标");
  assert.equal(refuted.refuted, true);
  assert.equal(refuted.attributionVerified, false);
  assert.equal(refuted.subdirLabel, false, "驳回后不挂「仓库内子包」");

  const confirmed = decideEntryAttribution({ node, resolved: resolvedOk, chosen: chosenSubdir, check: { verdict: "confirmed", reason: "package-json-name" } });
  assert.equal(confirmed.identity, node);
  assert.equal(confirmed.attributionVerified, true);
  assert.equal(confirmed.subdirLabel, true);

  const unverified = decideEntryAttribution({ node, resolved: resolvedOk, chosen: chosenSubdir, check: { verdict: "unverified", reason: "rate-limited" } });
  assert.equal(unverified.identity, node, "查不了不改写原有展示");
  assert.equal(unverified.attributionVerified, false, "查不了不算确证");
  assert.equal(unverified.subdirLabel, false);

  // 仓库根 package.json 自己写了包名的（resolved.item 且非 subdir）：目录字段写错不影响证据
  const notSubdir = decideEntryAttribution({
    node,
    resolved: { verified: true, item: { subdir: false }, node },
    chosen: { subdir: false },
    check: { verdict: "refuted", reason: "directory-missing" },
  });
  assert.equal(notSubdir.refuted, false, "仓库根 package.json 写明了包名的（非 subdir）不受目录字段影响");
  assert.equal(notSubdir.identity, node);
  assert.equal(notSubdir.attributionVerified, true);

  // npm 声明了官方仓库、但官方仓库并不声明这个包名：身份本来就是借的，目录再驳回就该脱掉
  const borrowed = decideEntryAttribution({
    node,
    resolved: { verified: false, item: null, node },
    chosen: { subdir: false },
    check: { verdict: "refuted", reason: "directory-missing" },
  });
  assert.equal(borrowed.refuted, true, "声称的目录不存在、仓库也没声明过这个包名 -> 驳回");
  assert.equal(borrowed.identity, null);
  assert.equal(borrowed.attributionVerified, false);

  const checkedOut = decideEntryAttribution({ node: { id: "a/b" }, resolved: { verified: false }, chosen: chosenSubdir, check: { verdict: "confirmed", reason: "package-json-name" } });
  assert.equal(checkedOut.attributionVerified, true, "目录里 package.json 名字对得上就是直接证据");

  const legacy = decideEntryAttribution({ node, resolved: { verified: true }, chosen: chosenSubdir, check: null });
  assert.equal(legacy.subdirLabel, true, "没查过（没配 token）保持原行为");
  assert.equal(legacy.attributionVerified, true);

  const ambiguous = decideEntryAttribution({ node: null, resolved: { verified: false }, chosen: null, check: null });
  assert.equal(ambiguous.identity, null);
  assert.equal(ambiguous.attributionVerified, false);
});
