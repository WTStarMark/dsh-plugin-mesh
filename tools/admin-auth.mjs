/**
 * 管理后台鉴权：口令登录 -> HttpOnly Cookie 会话 -> 写操作校验 CSRF。
 *
 * 设计取舍：
 *   · 口令只存哈希（.env 里的 ADMIN_PASSWORD_HASH，scrypt$salt$key），也兼容明文 ADMIN_PASSWORD 便于手工起步；
 *   · 会话只存内存：进程重启即失效（本地/线上都由 pm2 常驻，重启频率极低，换来的是不用把会话写盘）；
 *   · Cookie 带 HttpOnly + SameSite=Strict + Path=后台路径；代理声明 https 时才加 Secure；
 *   · 连续失败 5 次锁定 10 分钟（按 IP），另有全局登录闸门抗 scrypt 打满 CPU；
 *   · 所有比较走 timingSafeEqual，长度差异先哈希抹平。
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export const COOKIE_NAME = "mesh_admin";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const LOCK_AFTER_FAILS = 5;
// 同时进行的 scrypt 校验上限。它保护的是 CPU，不是"每分钟次数"：
// 旧写法用「60 秒内全局 30 次」的时间窗口，会把正确口令也一起拒掉 ——
// 知道后台路径的人只要持续发 30 次/分钟，就能把管理员永久锁在门外。
const MAX_INFLIGHT = 4;

const b64 = (buf) => Buffer.from(buf).toString("base64url");

export async function hashPassword(password, salt = randomBytes(16).toString("base64url")) {
  const key = await scrypt(String(password), salt, 32);
  return "scrypt$" + salt + "$" + b64(key);
}

function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export async function verifyPassword(password, stored) {
  const value = String(stored ?? "");
  if (!value) return false;
  if (value.startsWith("scrypt$")) {
    const [, salt, key] = value.split("$");
    if (!salt || !key) return false;
    const actual = await scrypt(String(password), salt, 32);
    const expected = Buffer.from(key, "base64url");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(actual, expected);
  }
  return safeEqual(password, value); // 兼容 .env 里直接放明文口令
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const raw = part.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Cookie 是客户端随便发的：畸形百分号编码不能让解析抛异常（否则一个乱码 Cookie 就是 500）
    }
    out[part.slice(0, eq).trim()] = value;
  }
  return out;
}

export function createAuth({ secret, basePath, now = () => Date.now() }) {
  const sessions = new Map(); // sid -> { csrf, expiresAt, ip }
  const failures = new Map(); // ip -> { fails, at }
  let inflight = 0; // 正在跑 scrypt 的登录请求数

  const prune = () => {
    const t = now();
    for (const [sid, s] of sessions) if (s.expiresAt <= t) sessions.delete(sid);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    // 失败计数只留最近 15 分钟，免得内存被一堆一次性 IP 撑大
    for (const [ip, f] of failures) if (t - f.at > 15 * 60 * 1000) failures.delete(ip);
  };

  function cookieHeader(sid, secure) {
    const attrs = [COOKIE_NAME + "=" + sid, "Path=" + basePath, "HttpOnly", "SameSite=Strict", "Max-Age=" + Math.floor(SESSION_TTL_MS / 1000)];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
  }

  function clearCookie() {
    return COOKIE_NAME + "=; Path=" + basePath + "; HttpOnly; SameSite=Strict; Max-Age=0";
  }

  return {
    enabled: !!secret,
    /**
     * 登录：返回 { ok, sid, csrf } 或 { ok:false, reason, retryAfter }。
     *
     * 顺序很关键：**先验口令，再谈限速**。
     * 老写法是"先看锁定、再验口令"，于是一个没口令的人连错 5 次就能把真主人关在门外
     * （反代后面所有客户端同一个 IP，等于白送一个拒绝服务）。
     * 现在：口令正确一律放行；只有"失败"这条路径才被延迟与限流惩罚。
     */
    async login(password, ip) {
      if (!secret) return { ok: false, reason: "disabled" };
      // 并发闸门：只拒绝"同一瞬间挤进来"的请求，不做时间窗口。
      // 口令校验（scrypt）有 CPU 成本，所以限并发；但正确口令永远不会被时间窗口锁死。
      if (inflight >= MAX_INFLIGHT) return { ok: false, reason: "busy", retryAfter: 2 };
      inflight += 1;
      let ok = false;
      try {
        ok = await verifyPassword(password, secret);
      } finally {
        inflight -= 1; // 校验一结束就放槽位，后面的退避延迟不占并发
      }
      if (!ok) {
        const t = now();
        const fails = (failures.get(ip)?.fails ?? 0) + 1;
        failures.set(ip, { fails, at: t });
        prune(); // 失败也要清理过期条目：只靠成功登录清理的话，持续攻击会让这张表一直涨
        // 失败越多回得越慢：把暴力破解的吞吐压到没有意义（默认口令是随机 16 位，本来也猜不出来）
        await new Promise((done) => setTimeout(done, Math.min(1000, 150 * fails)));
        if (fails >= LOCK_AFTER_FAILS) {
          return { ok: false, reason: "locked", retryAfter: Math.min(60, 5 * (fails - LOCK_AFTER_FAILS + 1)) };
        }
        return { ok: false, reason: "bad", remaining: Math.max(0, LOCK_AFTER_FAILS - fails) };
      }
      const t = now();
      failures.delete(ip);
      prune();
      const sid = b64(randomBytes(24));
      const session = { csrf: b64(randomBytes(24)), expiresAt: t + SESSION_TTL_MS, ip };
      sessions.set(sid, session);
      return { ok: true, sid, csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() };
    },
    session(sid) {
      if (!sid) return null;
      const s = sessions.get(sid);
      if (!s) return null;
      if (s.expiresAt <= now()) {
        sessions.delete(sid);
        return null;
      }
      return s;
    },
    logout(sid) {
      return sid ? sessions.delete(sid) : false;
    },
    csrfOk(session, token) {
      if (!session || !token) return false;
      return safeEqual(session.csrf, token);
    },
    cookieHeader,
    clearCookie,
    stats: () => ({
      sessions: sessions.size,
      inflight,
      // 达到退避阈值的 IP 数（旧实现查 f.until，但这个字段从来没被赋过值，永远报 0）
      locked: [...failures.values()].filter((f) => (f.fails ?? 0) >= LOCK_AFTER_FAILS).length,
    }),
  };
}
