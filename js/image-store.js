// メモ画像の永続化（IndexedDB）。LocalStorage は容量が小さいため画像本体はこちらに保存する。
// IndexedDB が使えない環境では保存をスキップする（画面上・エクスポートには影響しない）。

const DB_NAME = 'lma-images';
const STORE = 'images';
let dbPromise = null;

function openDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB を利用できません'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB を開けません'));
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const result = fn(store);
        t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        t.onerror = () => reject(t.error || new Error('IndexedDB エラー'));
        t.onabort = () => reject(t.error || new Error('IndexedDB の処理が中断されました'));
      })
  );
}

const savedIds = new Set();

/** 未保存の画像だけを書き込み、使われなくなった画像を削除する */
export async function syncImages(images) {
  const ids = Object.keys(images || {});
  const toPut = ids.filter((id) => !savedIds.has(id));
  const keys = await tx('readonly', (s) => s.getAllKeys());
  const stale = (keys || []).filter((k) => !ids.includes(k));
  if (!toPut.length && !stale.length) return;
  await tx('readwrite', (s) => {
    toPut.forEach((id) => s.put(images[id], id));
    stale.forEach((id) => s.delete(id));
  });
  toPut.forEach((id) => savedIds.add(id));
  stale.forEach((id) => savedIds.delete(id));
}

export async function loadImages(ids) {
  const out = {};
  if (!ids.length) return out;
  await tx('readonly', (s) => {
    ids.forEach((id) => {
      const req = s.get(id);
      req.onsuccess = () => {
        if (typeof req.result === 'string') {
          out[id] = req.result;
          savedIds.add(id);
        }
      };
    });
  });
  return out;
}

export async function clearImages() {
  savedIds.clear();
  try {
    await tx('readwrite', (s) => s.clear());
  } catch {
    /* ignore */
  }
}
