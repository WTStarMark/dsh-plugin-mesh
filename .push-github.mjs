/**
 * 用 api.github.com 的 Contents API 推送本次改动（该令牌只有 Contents 权限，
 * Git Data API 会 403）。逐文件 PUT，每个文件一个提交——远端历史本来就是这种风格。
 * 提交信息里带上本地提交号与本轮说明，便于回溯。令牌只从 .env 读，绝不打印。
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const OWNER = "WTStarMark";
const REPO = "dsh-plugin-mesh";
const BRANCH = "main";
const API = "https://api.github.com";

const env = await readFile(".env", "utf8");
const token = (/^GITHUB_TOKEN=(.+)$/m.exec(env)?.[1] ?? "").trim();
if (!token) throw new Error("没有读到 GITHUB_TOKEN");

const headers = {
  authorization: "Bearer " + token,
  accept: "application/vnd.github+json",
  "user-agent": "dsh-plugin-mesh-deploy",
  "content-type": "application/json",
};
const call = async (method, path, body) => {
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, json, scopes: res.headers.get("x-oauth-scopes") ?? "" };
};

const probe = await call("GET", "/repos/" + OWNER + "/" + REPO);
if (!probe.ok) throw new Error("仓库不可读: " + probe.status);
console.log("令牌权限: " + (probe.scopes || "(fine-grained，未暴露 scope 头)"));

const localSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const localSubject = execFileSync("git", ["log", "-1", "--format=%s", "HEAD"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);
console.log("待推送: " + files.length + " 个文件（本地提交 " + localSha + "）");

let ok = 0;
const failed = [];
for (const path of files) {
  const content = await readFile(path);
  const existing = await call("GET", "/repos/" + OWNER + "/" + REPO + "/contents/" + path + "?ref=" + BRANCH);
  const sha = existing.ok ? existing.json.sha : undefined;
  const put = await call("PUT", "/repos/" + OWNER + "/" + REPO + "/contents/" + path, {
    message: "v0.4.1: " + path + "（本地提交 " + localSha + " · " + localSubject.slice(0, 40) + "）",
    content: content.toString("base64"),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  });
  if (put.ok) {
    ok += 1;
    console.log("  ✓ " + path.padEnd(34) + (content.length / 1024).toFixed(1) + " KB  " + (put.json.commit?.sha ?? "").slice(0, 8));
  } else {
    failed.push(path + " → " + put.status + " " + (put.json.message ?? ""));
    console.log("  ✗ " + path.padEnd(34) + put.status + " " + (put.json.message ?? ""));
  }
}
console.log("成功 " + ok + " / " + files.length + (failed.length ? " | 失败: " + failed.join("; ") : ""));
