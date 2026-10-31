/**
 * 多重校验层单测：目录 package.json 的 repository 一致性、npm provenance（SLSA）、索引不变量自检。
 * 全部注入假 fetch，不联网。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT,
  judgeSubdirCheck,
  repoKeyFromUrl,
  parseProvenancePayload,
  createNpmProvenanceFetcher,
  runProvenanceVerification,
  provenanceCacheKey,
} from "../tools/repo-dir-verify.mjs";
import { applyProvenanceAttribution, applyAttributionOverrides, filterHiddenLabels, validateIndex } from "../tools/market-index.mjs";
import { normalizeOverrides } from "../tools/market-overrides.mjs";

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const slsaAttestation = (repo, commit) => [
  {
    predicateType: "https://slsa.dev/provenance/v1",
    bundle: {
      dsseEnvelope: {
        payload: b64({
          _type: "https://in-toto.io/Statement/v1",
          subject: [{ name: "pkg:npm/x@1.0.0" }],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {
            buildDefinition: {
              buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
              externalParameters: { workflow: { repository: repo, path: ".github/workflows/release.yml", ref: "refs/tags/v1.0.0" } },
              resolvedDependencies: [{ uri: "git+" + repo + "@refs/tags/v1.0.0", digest: { gitCommit: commit } }],
            },
            runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
          },
        }),
      },
    },
  },
];

function fakeFetch(resolver) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const out = resolver(url);
    if (out instanceof Error) throw out;
    return { status: out.status, text: async () => out.text ?? "", headers: { get: () => out.remaining ?? null } };
  };
  return { fetchImpl, calls };
}

test("repoKeyFromUrl：各种 repository 写法", () => {
  assert.equal(repoKeyFromUrl("git+https://github.com/a/b.git"), "a/b");
  assert.equal(repoKeyFromUrl("https://github.com/A/B"), "a/b");
  assert.equal(repoKeyFromUrl("git@github.com:a/b.git"), "a/b");
  assert.equal(repoKeyFromUrl({ url: "git+https://github.com/a/b", directory: "packages/x" }), "a/b");
  assert.equal(repoKeyFromUrl("."), null);
  assert.equal(repoKeyFromUrl("https://gitlab.com/a/b"), null);
});

test("目录 package.json 的 repository 必须与声称仓库一致", () => {
  const entry = { state: "verified", name: "pkg", repository: "git+https://github.com/other/repo.git", repoKey: "a/b" };
  assert.equal(judgeSubdirCheck(entry, "pkg", "a/b").verdict, VERDICT.UNVERIFIED);
  assert.match(judgeSubdirCheck(entry, "pkg", "a/b").reason, /repository-mismatch/);
  assert.equal(judgeSubdirCheck({ ...entry, repository: { url: "git+https://github.com/a/b.git", directory: "packages/x" } }, "pkg", "a/b").verdict, VERDICT.CONFIRMED);
  assert.equal(judgeSubdirCheck({ ...entry, repository: "." }, "pkg", "a/b").verdict, VERDICT.CONFIRMED, "相对路径取不到仓库 key，不参与比对");
  assert.equal(judgeSubdirCheck({ ...entry, repository: null }, "pkg", "a/b").verdict, VERDICT.CONFIRMED);
});

test("provenance payload 解析：SLSA -> 仓库 + commit；无 SLSA 返回 null", () => {
  const parsed = parseProvenancePayload(slsaAttestation("https://github.com/dsh-market/dsh-market", "2477c36"));
  assert.equal(parsed.repository, "https://github.com/dsh-market/dsh-market");
  assert.equal(parsed.commit, "2477c36");
  assert.equal(parseProvenancePayload([{ predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {} }]), null);
  assert.equal(parseProvenancePayload(null), null);
});

test("provenance 取数器：200 有溯源 / 404 无 / 5xx 重试 / 网络异常记 error", async () => {
  const ok = createNpmProvenanceFetcher({
    fetchImpl: fakeFetch(() => ({ status: 200, text: JSON.stringify({ attestations: slsaAttestation("https://github.com/a/b", "abc") }) })).fetchImpl,
    sleepFn: async () => {},
  });
  const got = await ok("pkg", "1.0.0");
  assert.equal(got.state, "ok");
  assert.equal(got.commit, "abc");
  const none = createNpmProvenanceFetcher({ fetchImpl: fakeFetch(() => ({ status: 404 })).fetchImpl, sleepFn: async () => {} });
  assert.equal((await none("pkg", "1.0.0")).state, "none");
  let calls = 0;
  const flaky = createNpmProvenanceFetcher({ fetchImpl: fakeFetch(() => (calls++ === 0 ? { status: 500 } : { status: 200, text: JSON.stringify({ attestations: slsaAttestation("https://github.com/a/b", "abc") }) })).fetchImpl, sleepFn: async () => {} });
  assert.equal((await flaky("pkg", "1.0.0")).state, "ok");
  const down = createNpmProvenanceFetcher({ fetchImpl: fakeFetch(() => new Error("ECONNRESET")).fetchImpl, sleepFn: async () => {} });
  assert.equal((await down("pkg", "1.0.0")).state, "error");
});

test("provenance 批量：按 pkg@version 缓存，第二次不再请求", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, text: JSON.stringify({ attestations: slsaAttestation("https://github.com/a/b", "abc") }) }));
  const fetcher = createNpmProvenanceFetcher({ fetchImpl, sleepFn: async () => {} });
  const targets = [{ pkg: "pkg", version: "1.0.0" }, { pkg: "pkg2", version: "2.0.0" }];
  const first = await runProvenanceVerification({ targets, cache: null, fetchProvenance: fetcher, now: 1000000 });
  assert.equal(first.stats.ok, 2);
  assert.equal(calls.length, 2);
  const second = await runProvenanceVerification({ targets, cache: first.cache, fetchProvenance: fetcher, now: 1000000 + 1000 });
  assert.equal(second.stats.cached, 2);
  assert.equal(calls.length, 2, "缓存命中不再请求");
  assert.ok(second.cache.entries[provenanceCacheKey("pkg", "1.0.0")]);
});

test("provenance 判定：一致强制确证、不一致强制驳回、无溯源不动", () => {
  const node = { id: "a/b", owner: "a", stars: 100 };
  const confirmed = { identity: node, refuted: false, attributionVerified: true, subdirLabel: true };
  const refuted = { identity: null, refuted: true, attributionVerified: false, subdirLabel: false };
  const okProv = { state: "ok", repository: "https://github.com/a/b", commit: "abc" };
  const badProv = { state: "ok", repository: "https://github.com/other/repo", commit: "abc" };
  assert.equal(applyProvenanceAttribution(confirmed, okProv, { node, repoKey: "a/b" }).provenance, "match");
  const rescued = applyProvenanceAttribution(refuted, okProv, { node, repoKey: "a/b" });
  assert.equal(rescued.refuted, false);
  assert.deepEqual(rescued.identity, node);
  const killed = applyProvenanceAttribution(confirmed, badProv, { node, repoKey: "a/b" });
  assert.equal(killed.refuted, true);
  assert.equal(killed.identity, null);
  assert.equal(applyProvenanceAttribution(confirmed, { state: "none" }, { node, repoKey: "a/b" }).provenance, "none");
  assert.equal(applyProvenanceAttribution(confirmed, { state: "error" }, { node, repoKey: "a/b" }).provenance, "error");
  // 人工裁决仍压过 provenance
  const overrides = normalizeOverrides({ entries: { pkg: { decision: "confirmed" } } });
  const final = applyAttributionOverrides({ pkg: "pkg", base: killed, node, rec: {}, repoId: "a/b", overrides });
  assert.equal(final.refuted, false);
  assert.equal(final.source, "manual:confirmed");
});


test("隐藏标签：条目与 metadata 都不输出（纯函数层）", () => {
  assert.deepEqual(filterHiddenLabels(["dsh-bundle", "owner-unverified", "star-cta"], new Set(["owner-unverified"])), ["dsh-bundle", "star-cta"]);
  assert.deepEqual(filterHiddenLabels(["a", "b"], ["b"]), ["a"]);
  assert.deepEqual(filterHiddenLabels(null, new Set(["x"])), []);
});

test("索引不变量自检：合法条目通过，坏条目逐条报出来", () => {
  const labels = new Set(["dsh-bundle", "owner-unverified", "provenance-verified", "star-cta"]);
  const good = {
    name: "pkg-a",
    title: "pkg-a",
    description: "x",
    icon: "https://avatars.githubusercontent.com/u/1?v=4",
    author: "a",
    repository: { url: "https://github.com/a/b" },
    metadata: { labels: ["dsh-bundle", "provenance-verified"], keywords: ["dsh"] },
    versions: [{ version: "1.0.0", publishTimestamp: 1790000000, source: { type: "npm" } }],
  };
  assert.deepEqual(validateIndex([good], labels), []);
  const noTitle = { ...good };
  delete noTitle.title;
  assert.deepEqual(validateIndex([noTitle], labels), [], "title 可选：缺省显示 name（省掉与 name 重复的字符串）");
  const bad = [
    { ...good, title: "repo-name" },
    { ...good, name: "pkg-a" },
    { ...good, name: "pkg-b", versions: [{ version: "1.0", publishTimestamp: 0, source: { type: "git" } }] },
    { ...good, name: "pkg-c", metadata: { labels: ["unknown-label"], keywords: [] } },
    { ...good, name: "pkg-d", repository: { url: "https://gitlab.com/a/b" } },
    { ...good, name: "pkg-e", repository: { url: "https://github.com/a/b" }, author: undefined, metadata: { labels: ["owner-unverified"], keywords: [] } },
  ];
  const violations = validateIndex(bad, labels);
  assert.ok(violations.length >= 7);
  assert.ok(violations.some((v) => v.pkg === "pkg-a" && /title/.test(v.why)));
  assert.ok(violations.some((v) => v.pkg === "pkg-b" && /semver/.test(v.why)));
  assert.ok(violations.some((v) => v.pkg === "pkg-b" && /publishTimestamp/.test(v.why)));
  assert.ok(violations.some((v) => v.pkg === "pkg-c" && /未声明/.test(v.why)));
  assert.ok(violations.some((v) => v.pkg === "pkg-d" && /repository\.url/.test(v.why)));
  assert.ok(violations.some((v) => v.pkg === "pkg-e" && /author/.test(v.why)));
});
