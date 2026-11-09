import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeClientEntry,
  analyzeUiFiles,
  exportTargets,
  tarballUrl,
  uiEvidenceVerdict,
} from "../tools/market-ui.mjs";

test("UI 证据：HTML/CSS/TSX 算界面；d.ts/sourcemap 与 vendor/docs/skills 模板不算", () => {
  const paths = [
    "README.md",
    "index.js",
    "theme.css",
    "vendor/example/widget.html",
    "docs/demo.css",
    "skills/brainstorming/scripts/frame-template.html",
    "test/fixture.html",
    "assets/template.html",
    "assets/report-template.html",
    "preview/gallery.html",
    "client/index.js",
    "src/ui/App.tsx",
    "dist/client.js",
    "lib/types/client/index.d.ts",
    "dist/client.js.map",
    "dist/client.browser.js",
    "src/client/settings.css",
  ];
  const out = analyzeUiFiles(paths);
  assert.equal(out.uiFiles, 3, "theme.css + src/ui/App.tsx + src/client/settings.css：" + JSON.stringify(out.uiSample));
  assert.equal(
    out.clientFiles,
    5,
    "client/index.js + src/ui/App.tsx + dist/client.js + dist/client.browser.js + src/client/settings.css：" + JSON.stringify(out.clientSample),
  );
  assert.ok(out.uiSample.includes("theme.css"));
  assert.ok(out.clientSample.includes("dist/client.browser.js"), "client.browser.js 这类入口也要认");
  assert.ok(!out.clientSample.some((p) => p.endsWith(".d.ts") || p.endsWith(".map")), "d.ts/sourcemap 不是运行时文件");
});

test("exports[./client]：解析条件对象、忽略类型声明、按发布包文件清单判存在", () => {
  const pkg = {
    dsh: { client: { platform: "web", inject: [] } },
    exports: {
      ".": { default: "./lib/index.js" },
      "./client": { types: "./lib/client.d.ts", default: "./lib/client.js" },
    },
  };
  const entry = analyzeClientEntry(pkg, ["lib/index.js", "lib/client.d.ts", "lib/client.js"]);
  assert.equal(entry.dshClient, true);
  assert.equal(entry.platform, "web");
  assert.deepEqual(entry.clientExport, [{ path: "lib/client.js", exists: true }]);
  assert.equal(entry.clientEntry, "lib/client.js", "只有真的出现在发布包清单里的入口才算");

  const missing = analyzeClientEntry(pkg, ["lib/index.js"]);
  assert.deepEqual(missing.clientExport, [{ path: "lib/client.js", exists: false }]);
  assert.equal(missing.clientEntry, null, "声明了入口但文件不在包里，不能算证据");

  assert.deepEqual(exportTargets("./client.js"), ["client.js"]);
  assert.deepEqual(exportTargets({ types: "./client.d.ts", default: "./client.js" }), ["client.js"]);
  assert.deepEqual(exportTargets(undefined), []);
});

test("判定：扫描失败不标；资源/真实入口/声明+运行时文件才标；host/headless 不标", () => {
  assert.equal(uiEvidenceVerdict(null).ui, false);
  assert.equal(uiEvidenceVerdict({ ok: false, uiFiles: 9, clientFiles: 9 }).ui, false, "扫描失败不能信数字");
  assert.equal(uiEvidenceVerdict({ ok: true, uiFiles: 1, clientFiles: 0 }).ui, true, "有 HTML/CSS/TSX 就算界面");
  assert.equal(
    uiEvidenceVerdict({ ok: true, dshClient: true, platform: "web", clientEntry: "lib/client.js" }).ui,
    true,
    "exports[./client] 入口真实存在",
  );
  assert.equal(
    uiEvidenceVerdict({ ok: true, dshClient: true, platform: "web", clientFiles: 2 }).ui,
    true,
    "声明 web client 且有运行时客户端文件",
  );
  assert.equal(
    uiEvidenceVerdict({ ok: true, dshClient: true, platform: "host", clientEntry: "lib/client.js" }).ui,
    false,
    "platform=host 没有浏览器界面",
  );
  assert.equal(
    uiEvidenceVerdict({ ok: true, dshClient: true, platform: "headless", clientFiles: 1 }).ui,
    false,
    "platform=headless 没有浏览器界面",
  );
  assert.equal(uiEvidenceVerdict({ ok: true, clientFiles: 1 }).ui, false, "只有 client 路径、无 dsh.client 自述时不能确认界面");
  const scanned = uiEvidenceVerdict({ ok: true, dshClient: true, platform: "web", uiFiles: 0, clientFiles: 0, clientEntry: null });
  assert.equal(scanned.verified, true);
  assert.equal(scanned.ui, false);
});

test("tarballUrl：普通包与 scoped 包都拼出标准 registry 地址", () => {
  assert.equal(tarballUrl("dsh-demo", "1.2.3"), "https://registry.npmjs.org/dsh-demo/-/dsh-demo-1.2.3.tgz");
  assert.equal(tarballUrl("@scope/dsh-demo", "1.2.3"), "https://registry.npmjs.org/@scope/dsh-demo/-/dsh-demo-1.2.3.tgz");
});
