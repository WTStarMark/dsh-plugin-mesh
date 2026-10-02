/**
 * 浏览器侧缓存：优先 IndexedDB，不可用时退化为内存 Map。
 *
 * 用途：
 *   - 缓存 data/mesh.json（几 MB 的索引），二次访问先秒开、再后台校验
 *   - 缓存头像 blob（避免每次刷新都重新下载几百张图）
 * IndexedDB 在 http 局域网地址下也可用（不像 Cache Storage 需要安全上下文）。
 */

const DB_NAME = "dsh-plugin-mesh";
const STORE = "kv";

export function createMemoryStore() {
  const map = new Map();
  return {
    kind: "memory",
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async del(key) {
      map.delete(key);
    },
  };
}

function openDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || indexedDB === null) {
      reject(new Error("当前环境没有 IndexedDB"));
      return;
    }
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
}

function withStore(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = run(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/** 打开缓存；任何异常都退化为内存版，绝不让缓存问题影响页面 */
export async function createStore(name = DB_NAME) {
  try {
    const db = await openDatabase(name);
    return {
      kind: "indexeddb",
      async get(key) {
        try {
          return (await withStore(db, "readonly", (s) => s.get(key))) ?? null;
        } catch {
          return null;
        }
      },
      async put(key, value) {
        try {
          await withStore(db, "readwrite", (s) => s.put(value, key));
        } catch {
          /* 配额满等情况忽略 */
        }
      },
      async del(key) {
        try {
          await withStore(db, "readwrite", (s) => s.delete(key));
        } catch {
          /* 忽略 */
        }
      },
    };
  } catch {
    return createMemoryStore();
  }
}
