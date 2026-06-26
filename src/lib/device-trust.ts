/**
 * Phone-side IndexedDB storage for the device-trust token.
 *
 * After a successful WebAuthn pairing, the server returns a signed
 * token bound to (devicePubKey, IP, exp:12h). We persist it here so
 * the next visit (within 12h, from the same IP) can present the
 * token in lieu of running another WebAuthn ceremony. Any server-side
 * rejection (expired / IP changed / pubkey mismatch / bad HMAC) →
 * 401 from /phone-attest → caller clears the token and falls back
 * to fresh WebAuthn.
 *
 * Storage lives at the captcha-dev-jw.argus.pw origin, NOT the SDK
 * iframe's origin — the SDK keypair stays where it is, this is just
 * the server-signed handle that vouches for the pairing of that
 * keypair with this network.
 */

const DB_NAME = 'argus-pair-trust';
const DB_VERSION = 1;
const STORE = 'tokens';
const KEY = 'phone-trust';
const PROBE_KEY = 'storage-probe';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadTrustToken(): Promise<string | null> {
  try {
    const db = await open();
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? (req.result as string) : null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveTrustToken(token: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(token, KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* best-effort persistence; falling back to fresh WebAuthn is fine */
  }
}

export async function clearTrustToken(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* best-effort */
  }
}

export async function detectPrivateStorageMode(): Promise<boolean> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(String(Date.now()), PROBE_KEY);
      const req = store.get(PROBE_KEY);
      req.onsuccess = () => {
        if (typeof req.result === 'string') resolve();
        else reject(new Error('indexeddb_probe_missing'));
      };
      req.onerror = () => reject(req.error);
    });
    window.localStorage.setItem(PROBE_KEY, '1');
    window.localStorage.removeItem(PROBE_KEY);
    return false;
  } catch {
    return true;
  }
}
