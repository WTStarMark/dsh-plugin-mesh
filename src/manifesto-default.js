/**
 * 倡议书默认内容：后台没保存过 / 文件损坏时的兜底。
 *
 * 这份内容原来写死在 index.html 的弹窗里，后台要能编辑（data/admin/manifesto.json），
 * 所以抽成模块：前端渲染、后台编辑、恢复默认三处共用同一份默认值。
 * html 是弹窗正文的片段（允许 mo-lead / mo-sec 这些现有样式类）。
 */
export const DEFAULT_MANIFESTO = {
  title: "生态图倡议书",
  subtitle: "让每个插件被找到，也让每个作者被看见",
  pages: [
    {
      id: "letter",
      label: "倡议书",
      html: "<p class=\"mo-lead\">这张图不是排行榜，是一张\"让人找到你的插件\"的地图。</p>\n\n      <section class=\"mo-sec\">\n        <h4><span class=\"mo-n\">01</span>我们为什么做这件事</h4>\n        <p>DSH 的插件散落在 GitHub 的各个角落，靠标签和搜索很难被看见。我们把它们按功能铺成一张可浏览的网：找得到、点得开、装得上。</p>\n      </section>\n\n      <section class=\"mo-sec\">\n        <h4><span class=\"mo-n\">02</span>我们怎么收录</h4>\n        <ul>\n          <li>带 dsh 系列主题标签，或仓库名里含 dsh；再按三档结论如实标注：相关 / 噪声 / 待人工复核。</li>\n          <li>数据来自 GitHub 搜索接口与 npm 官方接口，每小时更新；全程只读，不写入任何第三方仓库。</li>\n          <li>取不到的数据一律写「—」，绝不把\"取不到\"写成\"0\"。</li>\n        </ul>\n      </section>\n\n      <section class=\"mo-sec\">\n        <h4><span class=\"mo-n\">03</span>给插件作者的三句话</h4>\n        <ul>\n          <li>发到 npm，并在 package.json 里声明 <code>dsh.bundle</code> 或依赖 <code>@deepseek-ai/*</code>，这样能被自动认出来。</li>\n          <li>给仓库打上 <code>dsh-plugin</code> 等主题标签，并在 README 开头写清\"它解决什么问题\"。</li>\n          <li>插件住在单仓的子目录也照样收录：我们按 npm 反查加仓库内路径来认。</li>\n        </ul>\n      </section>\n\n      <section class=\"mo-sec\">\n        <h4><span class=\"mo-n\">04</span>给使用者的两句话</h4>\n        <ul>\n          <li>安装前看一眼仓库、许可证与最近提交时间。</li>\n          <li>用得上，就去仓库点个 Star —— 星标是作者继续更新的动力。</li>\n        </ul>\n      </section>\n\n      <section class=\"mo-sec mo-promise\">\n        <h4><span class=\"mo-n\">05</span>我们的承诺</h4>\n        <p>不伪造数据、不刷榜、不改动别人的仓库；索引源可自由引用，本站只读。</p>\n      </section>\n    </div>",
    },
    {
      id: "ai",
      label: "给 API 调用的说明",
      html: "<p class=\"mo-lead\">这一页说明本站 API 怎么调、有哪些规矩。</p>\n\n      <section class=\"mo-sec\">\n        <h4><span class=\"mo-n\">01</span>这是什么</h4>\n        <p>DSH 插件生态图的只读查询 API：三万个带 dsh 标签的 GitHub 仓库，每小时更新，无需鉴权。先调 <code>GET /api</code> 拿端点自述。</p>\n      </section>\n\n      <section class=\"mo-sec\">\n        <h4><span class=\"mo-n\">02</span>常用端点</h4>\n        <ul class=\"mo-api\">\n          <li><code>GET /api</code><span>端点自述与版本</span></li>\n          <li><code>GET /api/health</code><span>数据概况：节点数、README 索引规模、生成时间</span></li>\n          <li><code>GET /api/categories</code><span>功能扇区与细枝及各自计数</span></li>\n          <li><code>GET /api/repos</code><span>检索仓库，支持 q / tag / category / minStars / sort / limit / offset / fields=all</span></li>\n          <li><code>GET /api/repos/:owner/:name</code><span>单个仓库详情，含同作者与主题关联</span></li>\n          <li><code>GET /api/search</code><span>紧凑检索：只回 id 与计数，含 README 正文命中</span></li>\n          <li><code>GET /api/ranking</code><span>三张榜：周更新 / 周 star / 周 npm 下载，参数 days、limit、noise</span></li>\n          <li><code>GET /api/npm-nodes</code><span>有 npm 包的仓库 id 列表</span></li>\n          <li><code>GET /api/review-nodes</code><span>在评测站有公开测评的仓库与插件测评页链接（每 10 分钟同步；非「待复核」）</span></li>\n          <li><code>GET /market/index.json</code><span>DSH 插件市场索引，format 1，可直接加进 DSH</span></li>\n          <li><code>GET /api/card/:owner/:name.svg</code><span>可分享的仓库卡片</span></li>\n        </ul>\n      </section>\n\n      <section class=\"mo-sec\">\n        <h4><span class=\"mo-n\">03</span>调用规矩</h4>\n        <ul>\n          <li>只读、无需鉴权，但请勿高频轮询：接口按令牌计费，响应带 5 分钟公共缓存，重复拉同一份没有意义。</li>\n          <li>先读 <code>GET /api</code> 的自述，再挑端点；批量场景用 <code>/api/search</code>，别逐个拉详情。</li>\n          <li>请求带 <code>Accept-Encoding: gzip</code>：市场索引有几 MB，不压缩容易超时。</li>\n          <li>遇到 429 请按 <code>Retry-After</code> 退避，不要并发轰炸。</li>\n          <li>User-Agent 标明身份与用途，方便放行与排查。</li>\n        </ul>\n      </section>\n\n      <section class=\"mo-sec\">\n        <h4><span class=\"mo-n\">04</span>数据口径，别读错</h4>\n        <ul>\n          <li>缺数据一律是「—」或 <code>unknown</code>，<b>不是 0</b>；把\"取不到\"当成 0 会得出错误结论。</li>\n          <li><code>verdict</code> 三档：related / noise / manual；默认 <code>noise=all</code> 只标注、不过滤。</li>\n          <li>各榜窗口互相独立：npm 的最近 7 天与 star 的 7 个自然日不一定重合，行里带窗口字段。</li>\n          <li>星标与下载量都是采集时刻的快照，不是实时值。</li>\n        </ul>\n      </section>\n\n      <section class=\"mo-sec mo-promise\">\n        <h4><span class=\"mo-n\">05</span>引用与礼仪</h4>\n        <ul>\n          <li>索引源 <code>/market/index.json</code> 可自由引用给 DSH 使用；转载数据请保留出处与站点链接。</li>\n          <li>不要镜像全量后去掉署名，也不要用本站数据做刷榜或误导性排序。</li>\n          <li>发现数据错误，欢迎到项目仓库提 issue。</li>\n        </ul>\n      </section>",
    },
  ],
};
