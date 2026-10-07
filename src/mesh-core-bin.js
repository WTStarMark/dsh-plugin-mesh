/**
 * 二进制契约 mesh-core.bin（v0.4.8）：把预计算的绘图契约从 12MB JSON 压到几百 KB。
 *
 * 为什么能压这么多：JSON 里每个节点要重复 25 个键名、重复的标签/分类/理由文本
 * （实测 reason 只有 9 种取值、subcategory 80 种、category 21 种），
 * 而 id 里的 owner 前缀也和 owner 字段重复。二进制契约改成：
 *
 *   1. 【字典化】语言 / 分类 / 细枝 / 判定 / 理由 / 标签组合 / 命中词 各存一份表，节点里只放索引；
 *   2. 【数值化】坐标定点 Int16、半径 Uint8、推送时间压成"天数"Uint16；
 *   3. 【推导】name、owner 从 id 拆出来，categoryLabel 从字典取，avatar 只存数字 id；
 *   4. 【字符串池】id 连成一个池子（长度前缀），交给 Brotli 去压重复片段。
 *
 * 文件结构：
 *   [0..7]  "MESHCORE"           魔数
 *   [8..9]  version              Uint16
 *   [10..13] headerLength        Uint32
 *   [14..]  header JSON（UTF-8） 元信息 + 字典 + 各段的偏移/长度/标定
 *   [...]   各段二进制（Int16/Uint8/Uint32 小端）
 *
 * 编码器给 Node 工具用（tools/precompute-layout.mjs），解码器给浏览器用，
 * 两边共用本文件的格式定义，避免格式漂移。
 */

export const CORE_BIN_MAGIC = "MESHCORE";
export const CORE_BIN_VERSION = 1;
/** 头像尺寸：与 backend/dsh_mesh/build.py 的 AVATAR_SIZE 保持一致 */
export const AVATAR_SIZE = 64;

/**
 * 契约里认得的节点字段。编码时若出现清单外的字段，直接抛错 ——
 * 悄悄丢字段比构建失败更可怕（图上看不出来，但筛选/详情会莫名失效）。
 */
const KNOWN_NODE_FIELDS = new Set([
  "id", "name", "owner", "ownerType", "avatar", "stars", "forks", "pushedAt", "language",
  "archived", "fork", "matchedTags", "primaryTag", "relevance", "noise", "review", "verdict",
  "reason", "category", "categoryRaw", "categoryStrong", "categoryCurated", "categoryLabel", "categoryScore", "categoryHits",
  "subcategory", "subcategoryLabel", "degree", "x", "y", "r", "githubId", "renamedFrom",
]);

const MAGIC_BYTES = 8;
// 纪元起点取 2000-01-01：Uint16 天可覆盖到 2179 年，老仓库（2018 年推送的）也不会被截断成 0
const DAY_ZERO = Date.UTC(2000, 0, 1);
const DAY_MS = 86400000;
const EMPTY_LIST = Object.freeze([]);
const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------- 小工具 ---------------- */

function makeDict(values) {
  const list = [...new Set(values)].sort();
  const idx = new Map(list.map((v, i) => [v, i]));
  return { list, idx };
}

/** 提取 avatars.githubusercontent.com/u/<数字> 里的数字；不是这种形态返回 0 */
export function avatarIdOf(url) {
  const m = /^https:\/\/avatars\.githubusercontent\.com\/u\/(\d+)/.exec(String(url ?? ""));
  return m ? Number(m[1]) : 0;
}

/** 由数字 id 还原头像 URL（与 Python 端 sized_avatar 的输出一致） */
export function avatarUrlOf(id) {
  return id ? "https://avatars.githubusercontent.com/u/" + id + "?v=4&s=" + AVATAR_SIZE : null;
}

function writeStringPool(strings) {
  const parts = [];
  let bytes = 0;
  for (const s of strings) {
    const buf = enc.encode(s);
    if (buf.length > 65535) throw new Error("字符串过长: " + s.slice(0, 40));
    const len = new Uint8Array(2);
    new DataView(len.buffer).setUint16(0, buf.length, true);
    parts.push(len, buf);
    bytes += 2 + buf.length;
  }
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function readStringPool(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    const len = view.getUint16(at, true);
    at += 2;
    out.push(dec.decode(bytes.subarray(at, at + len)));
    at += len;
  }
  return out;
}

/* ---------------- 编码 ---------------- */

export function encodeCore(core, options = {}) {
  const nodes = core?.nodes ?? [];
  const edges = core?.edges ?? [];
  const arms = core?.arms ?? [];
  const n = nodes.length;

  const coordScale = Math.max(1, Math.min(64, Math.floor(32767 / Math.max(1, ...nodes.map((x) => Math.max(Math.abs(x.x ?? 0), Math.abs(x.y ?? 0)))))));
  const rScale = Math.max(1, Math.min(64, Math.floor(255 / Math.max(1, ...nodes.map((x) => x.r ?? 0)))));
  const scoreScale = 100;
  const indexWidth = n > 65535 || edges.some((e) => e[0] > 65535 || e[1] > 65535) ? 4 : 2;

  const langs = makeDict(nodes.map((x) => x.language ?? ""));
  const cats = makeDict(nodes.map((x) => x.category ?? "other"));
  const rawCats = makeDict(nodes.map((x) => x.categoryRaw ?? ""));
  const renamed = makeDict(nodes.map((x) => x.renamedFrom ?? ""));
  const subs = makeDict(nodes.map((x) => x.subcategory ?? ""));
  const verdicts = makeDict(nodes.map((x) => x.verdict ?? ""));
  const reasons = makeDict(nodes.map((x) => x.reason ?? ""));
  const tagSets = makeDict(nodes.map((x) => JSON.stringify(x.matchedTags ?? [])));
  const hits = makeDict(nodes.map((x) => JSON.stringify(x.categoryHits ?? [])));
  const catLabels = makeDict(nodes.map((x) => x.categoryLabel ?? ""));
  const subLabels = makeDict(nodes.map((x) => x.subcategoryLabel ?? ""));
  const primaryTags = makeDict(nodes.map((x) => x.primaryTag ?? ""));
  const avatarExceptions = new Map(); // 非标准头像 URL：编号从 1 开始
  for (const x of nodes) {
    const url = String(x.avatar ?? "");
    if (url && avatarIdOf(url) === 0 && !avatarExceptions.has(url)) avatarExceptions.set(url, avatarExceptions.size + 1);
  }

  const ids = writeStringPool(nodes.map((x) => String(x.id ?? "")));

  const sections = [];
  const push = (name, arr) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    sections.push({ name, bytes });
    return bytes.length;
  };

  const sec = {
    x: new Int16Array(n),
    y: new Int16Array(n),
    r: new Uint8Array(n),
    stars: new Uint32Array(n),
    forks: new Uint16Array(n),
    pushedDays: new Uint16Array(n),
    degree: new Uint8Array(n),
    score: new Uint16Array(n),
    avatarId: new Uint32Array(n),
    avatarEx: new Uint16Array(n),
    langIdx: new Uint8Array(n),
    catIdx: new Uint8Array(n),
    subIdx: new Uint8Array(n),
    verdictIdx: new Uint8Array(n),
    reasonIdx: new Uint8Array(n),
    tagIdx: new Uint8Array(n),
    hitsIdx: new Uint16Array(n),
    primaryTagIdx: new Uint8Array(n),
    catRawIdx: new Uint8Array(n),
    renamedIdx: new Uint16Array(n),
    githubId: new Uint32Array(n),
    catLabelIdx: new Uint8Array(n),
    subLabelIdx: new Uint8Array(n),
    relevance: new Uint8Array(n),
    flags: new Uint8Array(n),
  };

  // 未知字段的处理策略（v0.5.0 改）：
  //   默认 —— 跳过该字段 + 收集名字 + 最后告警一次，绝不中断编码。
  //   原因：抛错会让预计算在【写完 mesh-core.json、还没写 mesh-core.bin】时崩掉，
  //   二进制契约从此不再刷新，而采集器又把退出码 1 当成"产物已更新"——契约被静默冻结。
  //   strict: true（CI / 单测用）仍然直接抛错，保证字段不会在无人察觉的情况下丢掉。
  const dropped = new Set();
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    for (const key of Object.keys(node)) {
      if (KNOWN_NODE_FIELDS.has(key)) continue;
      if (options.strict) throw new Error("mesh-core.bin 不认识的节点字段：" + key + "（节点 " + node.id + "）");
      dropped.add(key);
    }
    sec.x[i] = Math.round((node.x ?? 0) * coordScale);
    sec.y[i] = Math.round((node.y ?? 0) * coordScale);
    sec.r[i] = Math.max(1, Math.round((node.r ?? 1) * rScale));
    sec.stars[i] = Math.min(4294967295, Math.max(0, Math.round(node.stars ?? 0)));
    sec.forks[i] = Math.min(65535, Math.max(0, Math.round(node.forks ?? 0)));
    const pushed = Date.parse(node.pushedAt ?? "");
    // 用 floor 截断到"天"：round 会把下午的时间推到第二天，跨天比较就对不上了
    sec.pushedDays[i] = Number.isFinite(pushed) ? Math.max(0, Math.min(65535, Math.floor((pushed - DAY_ZERO) / DAY_MS))) : 0;
    sec.degree[i] = Math.min(255, Math.max(0, Math.round(node.degree ?? 0)));
    sec.score[i] = Math.min(65535, Math.max(0, Math.round((node.categoryScore ?? 0) * scoreScale)));
    const aid = avatarIdOf(node.avatar);
    sec.avatarId[i] = aid;
    const ex = aid === 0 && node.avatar ? avatarExceptions.get(String(node.avatar)) ?? 0 : 0;
    sec.avatarEx[i] = ex;
    sec.langIdx[i] = langs.idx.get(node.language ?? "") ?? 0;
    sec.catIdx[i] = cats.idx.get(node.category ?? "other") ?? 0;
    sec.catRawIdx[i] = rawCats.idx.get(node.categoryRaw ?? "") ?? 0;
    sec.renamedIdx[i] = renamed.idx.get(node.renamedFrom ?? "") ?? 0;
    sec.githubId[i] = Math.max(0, Math.min(4294967295, Math.round(node.githubId ?? 0)));
    sec.subIdx[i] = subs.idx.get(node.subcategory ?? "") ?? 0;
    sec.verdictIdx[i] = verdicts.idx.get(node.verdict ?? "") ?? 0;
    sec.reasonIdx[i] = reasons.idx.get(node.reason ?? "") ?? 0;
    sec.tagIdx[i] = tagSets.idx.get(JSON.stringify(node.matchedTags ?? [])) ?? 0;
    sec.hitsIdx[i] = hits.idx.get(JSON.stringify(node.categoryHits ?? [])) ?? 0;
    sec.primaryTagIdx[i] = primaryTags.idx.get(node.primaryTag ?? "") ?? 0;
    sec.catLabelIdx[i] = catLabels.idx.get(node.categoryLabel ?? "") ?? 0;
    sec.subLabelIdx[i] = subLabels.idx.get(node.subcategoryLabel ?? "") ?? 0;
    sec.relevance[i] = Math.min(255, Math.max(0, Math.round(node.relevance ?? 0)));
    sec.flags[i] =
      (node.archived ? 1 : 0) |
      (node.fork ? 2 : 0) |
      (node.noise ? 4 : 0) |
      (node.review ? 8 : 0) |
      (node.ownerType === "Organization" ? 16 : 0) |
      (node.categoryStrong ? 32 : 0) |
      (node.categoryCurated ? 64 : 0);
  }

  const edgeIndex = new Uint16Array(edges.length * 2);
  const edgeType = new Uint8Array(edges.length);
  if (indexWidth === 2) {
    const ei = new Uint16Array(edges.length * 2);
    for (let i = 0; i < edges.length; i++) {
      ei[i * 2] = edges[i][0];
      ei[i * 2 + 1] = edges[i][1];
      edgeType[i] = edges[i][2] ?? 0;
    }
    sections.push({ name: "edgeIndex", bytes: new Uint8Array(ei.buffer) });
    void edgeIndex;
  } else {
    const ei = new Uint32Array(edges.length * 2);
    for (let i = 0; i < edges.length; i++) {
      ei[i * 2] = edges[i][0];
      ei[i * 2 + 1] = edges[i][1];
      edgeType[i] = edges[i][2] ?? 0;
    }
    sections.push({ name: "edgeIndex", bytes: new Uint8Array(ei.buffer) });
  }
  sections.push({ name: "edgeType", bytes: edgeType });

  let membersTotal = 0;
  for (const a of arms) membersTotal += (a.members ?? []).length;
  const memberArr = indexWidth === 2 ? new Uint16Array(membersTotal) : new Uint32Array(membersTotal);
  const armMeta = [];
  let mAt = 0;
  for (const a of arms) {
    const members = a.members ?? [];
    for (const m of members) memberArr[mAt++] = m;
    const { members: _drop, ...rest } = a;
    armMeta.push({ ...rest, membersOffset: mAt - members.length, membersCount: members.length });
  }
  sections.push({ name: "armMembers", bytes: new Uint8Array(memberArr.buffer) });

  for (const key of Object.keys(sec)) push(key, sec[key]);
  sections.push({ name: "ids", bytes: ids });

  if (dropped.size) {
    // 告警要显眼：字段被跳过意味着图上少一块信息，必须有人去补编解码器
    console.warn(
      "[mesh-core-bin] 跳过 " + dropped.size + " 个未纳入契约的节点字段：" + [...dropped].join(", ") +
        "（数据仍会生成，但这些字段不在二进制契约里；请同步更新 KNOWN_NODE_FIELDS 与编解码器）",
    );
  }

  const header = {
    v: CORE_BIN_VERSION,
    droppedFields: [...dropped],
    meta: core?.meta ?? {},
    tags: core?.tags ?? {},
    hubs: core?.hubs ?? [],
    clusters: core?.clusters ?? [],
    arms: armMeta,
    dict: {
      languages: langs.list,
      categories: cats.list,
      categoryRaws: rawCats.list,
      renamedFroms: renamed.list,
      subcategories: subs.list,
      categoryLabels: catLabels.list,
      subcategoryLabels: subLabels.list,
      verdicts: verdicts.list,
      reasons: reasons.list,
      tagSets: tagSets.list,
      hits: hits.list,
      primaryTags: primaryTags.list,
      avatarExceptions: Object.fromEntries(avatarExceptions),
    },
    scales: { coord: coordScale, r: rScale, score: scoreScale },
    indexWidth,
    count: n,
    sections: [],
  };

  // header 里要写各段偏移，而偏移本身会改变 header 的长度 —— 迭代到"长度自洽"为止，
  // 最后按定长补空格（JSON.parse 允许尾部空白）。否则段偏移会整体错位，解出来是乱码。
  // 每段起始按 4 字节对齐：TypedArray 视图（Uint32Array 等）要求对齐，否则构造就抛错
  const fillSections = (headerLen) => {
    let at = 14 + headerLen;
    header.sections = sections.map((s) => {
      at = Math.ceil(at / 4) * 4;
      const rec = { name: s.name, offset: at, length: s.bytes.length };
      at += s.bytes.length;
      return rec;
    });
    return at;
  };
  let headerLen = 0;
  let json = "";
  let jsonBytes = 0;
  for (let pass = 0; pass < 10; pass++) {
    fillSections(headerLen);
    json = JSON.stringify(header);
    jsonBytes = enc.encode(json).length; // 中文按 UTF-8 算字节，不能拿字符串长度比
    if (jsonBytes <= headerLen) break;
    headerLen = jsonBytes;
  }
  fillSections(headerLen); // 偏移按最终长度重算
  json = JSON.stringify(header);
  jsonBytes = enc.encode(json).length;
  if (jsonBytes > headerLen) throw new Error("header 长度无法收敛：" + jsonBytes + " > " + headerLen);

  const headerBytes = new Uint8Array(headerLen).fill(0x20); // 空格填充
  headerBytes.set(enc.encode(json), 0);

  const total = Math.ceil(fillSections(headerLen) / 4) * 4; // 末段也补齐
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(enc.encode(CORE_BIN_MAGIC), 0);
  view.setUint16(MAGIC_BYTES, CORE_BIN_VERSION, true);
  view.setUint32(MAGIC_BYTES + 2, headerLen, true);
  out.set(headerBytes, 14);
  for (const s of sections) out.set(s.bytes, header.sections.find((h) => h.name === s.name).offset);
  return out;
}

/* ---------------- 解码 ---------------- */

export function decodeCore(buffer, options = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dec.decode(bytes.subarray(0, MAGIC_BYTES)) !== CORE_BIN_MAGIC) throw new Error("不是 mesh-core.bin");
  const version = view.getUint16(MAGIC_BYTES, true);
  if (version !== CORE_BIN_VERSION) throw new Error("契约版本不匹配：" + version);
  const headerLength = view.getUint32(MAGIC_BYTES + 2, true);
  const header = JSON.parse(dec.decode(bytes.subarray(14, 14 + headerLength)));
  const at = (name) => header.sections.find((s) => s.name === name);
  const arr = (name, Type) => {
    const s = at(name);
    const start = bytes.byteOffset + s.offset;
    if (start % Type.BYTES_PER_ELEMENT === 0) return new Type(bytes.buffer, start, s.length / Type.BYTES_PER_ELEMENT);
    // 极端情况（数据是按字节范围切出来的）下视图不对齐：拷一份再解释
    const copy = bytes.slice(s.offset, s.offset + s.length);
    return new Type(copy.buffer, 0, s.length / Type.BYTES_PER_ELEMENT);
  };
  const idsSection = at("ids");
  const pool = readStringPool(bytes.subarray(idsSection.offset, idsSection.offset + idsSection.length));

  const d = header.dict;
  const n = header.count;
  const coordScale = header.scales.coord;
  const rScale = header.scales.r;
  const scoreScale = header.scales.score;

  const sx = arr("x", Int16Array);
  const sy = arr("y", Int16Array);
  const sr = arr("r", Uint8Array);
  const stars = arr("stars", Uint32Array);
  const forks = arr("forks", Uint16Array);
  const pushedDays = arr("pushedDays", Uint16Array);
  const degree = arr("degree", Uint8Array);
  const score = arr("score", Uint16Array);
  const avatarId = arr("avatarId", Uint32Array);
  const avatarEx = arr("avatarEx", Uint16Array);
  const langIdx = arr("langIdx", Uint8Array);
  const catIdx = arr("catIdx", Uint8Array);
  const catRawIdx = arr("catRawIdx", Uint8Array);
  const renamedIdx = arr("renamedIdx", Uint16Array);
  const githubIds = arr("githubId", Uint32Array);
  const subIdx = arr("subIdx", Uint8Array);
  const verdictIdx = arr("verdictIdx", Uint8Array);
  const reasonIdx = arr("reasonIdx", Uint8Array);
  const tagIdx = arr("tagIdx", Uint8Array);
  const hitsIdx = arr("hitsIdx", Uint16Array);
  const primaryTagIdx = arr("primaryTagIdx", Uint8Array);
  const catLabelIdx = arr("catLabelIdx", Uint8Array);
  const subLabelIdx = arr("subLabelIdx", Uint8Array);
  const relevance = arr("relevance", Uint8Array);
  const flags = arr("flags", Uint8Array);
  const edgesIdx = header.indexWidth === 2 ? arr("edgeIndex", Uint16Array) : arr("edgeIndex", Uint32Array);
  const edgeType = arr("edgeType", Uint8Array);

  const exEntries = Object.entries(d.avatarExceptions ?? {}).map(([url, id]) => [Number(id), url]);
  const exById = new Map(exEntries);

  // 字典先解析好：matchedTags/categoryHits 全图只有几十/上千种组合，
  // 逐节点 JSON.parse 是三万多次调用（实测占了解码时间的大头）。这些数组只读，可安全共享。
  const tagSets = d.tagSets.map((s) => JSON.parse(s || "[]"));
  const hitSets = d.hits.map((s) => JSON.parse(s || "[]"));
  // 推送时间按"天"记忆化：节点上万但不同日期只有几百个，逐节点 toISOString() 很贵
  const dayCache = new Map();
  const isoOfDay = (days) => {
    let v = dayCache.get(days);
    if (v === undefined) {
      v = new Date(DAY_ZERO + days * DAY_MS).toISOString().replace(".000Z", "Z");
      dayCache.set(days, v);
    }
    return v;
  };

  const nodes = new Array(n);
  const buildRange = (from, to) => {
    for (let i = from; i < to; i++) {
    const id = pool[i] ?? "";
    const slash = id.indexOf("/");
    const f = flags[i];
    nodes[i] = {
      id,
      name: slash >= 0 ? id.slice(slash + 1) : id,
      owner: slash >= 0 ? id.slice(0, slash) : id,
      ownerType: f & 16 ? "Organization" : "User",
      avatar: avatarEx[i] ? exById.get(avatarEx[i]) ?? null : avatarUrlOf(avatarId[i]),
      stars: stars[i],
      forks: forks[i],
      pushedAt: pushedDays[i] ? isoOfDay(pushedDays[i]) : null,
      language: d.languages[langIdx[i]] || null,
      archived: !!(f & 1),
      fork: !!(f & 2),
      matchedTags: tagSets[tagIdx[i]] ?? EMPTY_LIST,
      primaryTag: d.primaryTags[primaryTagIdx[i]] || null,
      relevance: relevance[i],
      noise: !!(f & 4),
      review: !!(f & 8),
      verdict: d.verdicts[verdictIdx[i]] || null,
      reason: d.reasons[reasonIdx[i]] || null,
      category: d.categories[catIdx[i]] || null,
      categoryLabel: d.categoryLabels[catLabelIdx[i]] || null,
      categoryScore: score[i] / scoreScale,
      categoryHits: hitSets[hitsIdx[i]] ?? EMPTY_LIST,
      subcategory: d.subcategories[subIdx[i]] || null,
      subcategoryLabel: d.subcategoryLabels[subLabelIdx[i]] || null,
      degree: degree[i],
      x: sx[i] / coordScale,
      y: sy[i] / coordScale,
      r: sr[i] / rScale,
    };
    // 可选字段：源数据里【没有】这个键时，解出来也不能凭空多一个 null，否则键集合对不上
    const wasNamed = (d.renamedFroms ?? [])[renamedIdx[i]];
    if (wasNamed) nodes[i].renamedFrom = wasNamed;
    const rawCat = d.categoryRaws[catRawIdx[i]];
    if (rawCat) nodes[i].categoryRaw = rawCat;
    if (f & 32) nodes[i].categoryStrong = true;
    if (f & 64) nodes[i].categoryCurated = true;
    if (githubIds[i]) nodes[i].githubId = githubIds[i];
    }
  };
  if (!options.yielding) buildRange(0, n);

  const finish = () => {
  const edges = new Array(edgesIdx.length / 2);
  for (let i = 0; i < edges.length; i++) edges[i] = [edgesIdx[i * 2], edgesIdx[i * 2 + 1], edgeType[i]];

  const memberType = header.indexWidth === 2 ? Uint16Array : Uint32Array;
  const memberBytes = at("armMembers");
  const members = new memberType(bytes.buffer, bytes.byteOffset + memberBytes.offset, memberBytes.length / memberType.BYTES_PER_ELEMENT);
  const arms = header.arms.map((a) => ({
    ...a,
    members: Array.from(members.subarray(a.membersOffset, a.membersOffset + a.membersCount)),
  }));

  return { meta: header.meta, tags: header.tags, hubs: header.hubs, clusters: header.clusters, arms, nodes, edges };
  };

  if (!options.yielding) return finish();
  // 分块模式：每块之间让出主线程（默认交还一帧），把"解 1.7 万个节点"摊到多帧里，
  // 总时长几乎不变，但界面全程可交互 —— 这是"切换整份数据不再卡几秒"的关键。
  const step = Math.max(200, options.chunk ?? 800);
  const yieldFn = options.yieldFn ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
  return (async () => {
    for (let i = 0; i < n; i += step) {
      buildRange(i, Math.min(n, i + step));
      await yieldFn();
    }
    return finish();
  })();
}

/** 分块解码的便捷入口（浏览器里用 requestAnimationFrame 让帧） */
export function decodeCoreAsync(buffer, options = {}) {
  const yieldFn =
    options.yieldFn ??
    (typeof requestAnimationFrame === "function" ? () => new Promise((resolve) => requestAnimationFrame(() => resolve())) : undefined);
  return decodeCore(buffer, { ...options, yielding: true, yieldFn });
}

/* ---------------- 首屏分片 ---------------- */

/**
 * 取"主干"分片：按星标取前 limit 个节点，重建 arms/edges/索引，并标记 meta.partial。
 * 先画主干、后台再换整份 —— 首屏只下几十 KB。
 */
export function subsetCore(core, limit) {
  const nodes = core?.nodes ?? [];
  if (nodes.length <= limit) return core;
  const keep = [];
  for (let i = 0; i < nodes.length; i++) keep.push(i);
  keep.sort((a, b) => (nodes[b].stars ?? 0) - (nodes[a].stars ?? 0));
  const picked = keep.slice(0, limit).sort((a, b) => a - b);
  const remap = new Map(picked.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  const out = {
    meta: { ...(core.meta ?? {}), partial: true, partialNodes: picked.length, sampleNodes: picked.length },
    tags: core.tags,
    hubs: core.hubs,
    clusters: (core.clusters ?? []).map((c) => {
      const count = picked.reduce((s, i) => s + (nodes[i].category === c.id ? 1 : 0), 0);
      return { ...c, count };
    }).filter((c) => c.count > 0),
    arms: (core.arms ?? []).map((a) => {
      const members = (a.members ?? []).map((i) => remap.get(i)).filter((i) => i !== undefined);
      return { ...a, members, count: members.length };
    }).filter((a) => a.members.length > 0),
    nodes: picked.map((i) => nodes[i]),
    edges: (core.edges ?? []).filter((e) => remap.has(e[0]) && remap.has(e[1])).map((e) => [remap.get(e[0]), remap.get(e[1]), e[2]]),
  };
  return out;
}
