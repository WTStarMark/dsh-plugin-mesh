/**
 * 市场索引「含界面 / Has UI」标签的证据判定（纯函数，可单测）。
 *
 * 背景：旧标签直接读 npm package.json 的 dsh.client 字段 —— 那是作者的声明，没看过包里
 * 到底有没有那个文件。按 DSH 的组合包约定，浏览器半边放在 exports["./client"] 指向的入口
 * （package.json 的 dsh.client 声明后由宿主发现），所以「真实检验」= 打开发布包的**文件清单**
 * 与 package.json，确认入口文件真的存在，而不是相信声明。
 *
 * 判定口径（保守、可解释，全部来自 npm 已发布的包内容）：
 *   1. 发布包里有前端资源文件：.html/.htm/.css/.scss/.sass/.less/.styl/.vue/.svelte/.jsx/.tsx
 *      → 含界面（用户口径：有 HTML/CSS 就算）。.d.ts / .map 不算运行时资源。
 *   2. 声明了 dsh.client，且 exports["./client"] 指向的入口文件真的在发布包里 → 含界面。
 *   3. 声明了 dsh.client（platform 不是 host/headless），且发布包里有运行时客户端入口文件 → 含界面。
 *   4. 其余 = 扫过、没有界面证据；扫描失败 = 未验证 = 不打标签。
 *
 * 忽略 vendor / node_modules / test(s) / spec / docs / examples / fixtures / demo / skills / .github
 * 等目录，以及 template/preview/sample/report 类文件名 —— 例如技能包自带的教学 HTML 模板
 * 不应该把包标成「含界面」，API client（dumate-client.js 这种）也不应该被当成人机界面。
 */

const UI_EXT = /\.(html?|css|scss|sass|less|styl|vue|svelte|jsx|tsx)$/i;
/* 运行时客户端入口：client.js / lib/client.js / client.browser.js / src/ui/App.tsx / web/index.js … */
const CLIENT_RUNTIME = /(^|\/)(client|web|ui|browser|frontend|renderer)([-_.\/]|$)/i;
/* 类型声明与 sourcemap 不是运行时资源：旧扫描把它们当成了客户端入口的证据。 */
const NON_RUNTIME = /\.d\.ts$|\.d\.tsx$|\.map$/i;
const IGNORED_SEGMENTS = new Set([
  "node_modules", "vendor", "third_party", "third-party", "test", "tests", "__tests__",
  "spec", "specs", "docs", "doc", "examples", "example", "fixtures", "fixture", "demo",
  "demos", "coverage", ".github", ".git", "skills", "skill",
  "templates", "template", "previews", "preview", "samples", "sample", "references",
  "try_it_out", "starter", "benchmark", "benchmarks", "bench", "guides", "guide",
]);
/* 模板/预览/报告/样例类文件名不算界面：例如 assets/template.html、report-template.html、menu-preview.html */
const IGNORED_BASENAME = /(^|[-_.])(template|preview|sample|report|guide|benchmark|starter)([-_.]|$)/i;
/* dsh.client.platform 只认 web：host / headless 没有浏览器半边，不该挂「含界面」。 */
const NON_WEB_PLATFORMS = new Set(["host", "headless"]);

function normalizePath(raw) {
  return String(raw ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function isIgnored(path) {
  const segs = path.toLowerCase().split("/");
  if (segs.some((s) => IGNORED_SEGMENTS.has(s))) return true;
  const base = segs[segs.length - 1] ?? "";
  return IGNORED_BASENAME.test(base);
}

/** 从文件路径清单里提取 UI 证据。返回计数与少量样本（供缓存/复核用）。 */
export function analyzeUiFiles(paths) {
  const ui = [];
  const client = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = normalizePath(raw);
    if (!p || isIgnored(p)) continue;
    if (NON_RUNTIME.test(p)) continue;
    if (UI_EXT.test(p)) ui.push(p);
    if (CLIENT_RUNTIME.test(p)) client.push(p);
  }
  return {
    files: Array.isArray(paths) ? paths.length : 0,
    uiFiles: ui.length,
    clientFiles: client.length,
    uiSample: ui.slice(0, 8),
    clientSample: client.slice(0, 8),
  };
}

/** 把 exports["./client"] 的字符串 / 条件对象摊平成候选文件路径（忽略通配符与类型声明）。 */
export function exportTargets(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(normalizePath(v));
    else if (v && typeof v === "object") for (const key of Object.keys(v)) walk(v[key]);
  };
  walk(value);
  return out.filter((p) => p && !p.includes("*") && !NON_RUNTIME.test(p));
}

/**
 * 从 package.json + 发布包文件清单里解析客户端入口。
 * @returns {{dshClient:boolean, platform:string|null, clientExport:{path:string,exists:boolean}[], clientEntry:string|null}}
 */
export function analyzeClientEntry(pkgJson, filePaths) {
  const pkg = pkgJson && typeof pkgJson === "object" ? pkgJson : {};
  const dsh = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : null;
  const client = dsh && dsh.client && typeof dsh.client === "object" ? dsh.client : null;
  const platform = client && typeof client.platform === "string" ? client.platform.toLowerCase() : null;
  const files = new Set((Array.isArray(filePaths) ? filePaths : []).map(normalizePath));
  const clientExport = exportTargets(pkg.exports && pkg.exports["./client"]).map((path) => ({ path, exists: files.has(path) }));
  const clientEntry = clientExport.find((item) => item.exists)?.path ?? null;
  return { dshClient: !!client, platform, clientExport, clientEntry };
}

/**
 * 单条扫描记录的标签判定。
 * @param {{ok?:boolean, uiFiles?:number, clientFiles?:number, dshClient?:boolean,
 *          platform?:string|null, clientEntry?:string|null}} record
 * @returns {{verified:boolean, ui:boolean, reason:string}}
 */
export function uiEvidenceVerdict(record) {
  if (!record || record.ok !== true) return { verified: false, ui: false, reason: "未扫描成功，不能标「含界面」" };
  const uiFiles = Number(record.uiFiles) || 0;
  if (uiFiles > 0) return { verified: true, ui: true, reason: "发布包里有 " + uiFiles + " 个前端资源文件" };
  const platform = typeof record.platform === "string" ? record.platform.toLowerCase() : null;
  const declared = record.dshClient === true;
  const nonWeb = platform !== null && NON_WEB_PLATFORMS.has(platform);
  if (declared && nonWeb) return { verified: true, ui: false, reason: "dsh.client 的平台是 " + platform + "，没有浏览器界面" };
  const entry = typeof record.clientEntry === "string" && record.clientEntry ? record.clientEntry : null;
  if (declared && entry) return { verified: true, ui: true, reason: "dsh.client 声明的 exports[./client] 入口真实存在：" + entry };
  const clientFiles = Number(record.clientFiles) || 0;
  if (declared && clientFiles > 0) return { verified: true, ui: true, reason: "声明 dsh.client，且有 " + clientFiles + " 个运行时客户端入口文件" };
  if (clientFiles > 0) return { verified: false, ui: false, reason: "只有客户端路径文件，但没有 dsh.client 自述，不能确认是界面" };
  return { verified: true, ui: false, reason: "扫描过，没有前端资源或客户端入口文件" };
}

/** npm tarball 的标准下载地址（scoped 包也适用）。 */
export function tarballUrl(name, version) {
  const base = String(name).split("/").pop();
  return "https://registry.npmjs.org/" + name + "/-/" + base + "-" + version + ".tgz";
}
