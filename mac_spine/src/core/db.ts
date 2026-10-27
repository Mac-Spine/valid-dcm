import { DB_NAME, DB_VERSION, MAX_AUDIT_ENTRIES, MAX_LOCAL_SESSIONS } from '../constants';
import { runMigrations } from './db-migrations';
import type {
  UserProfile,
  AssessmentResult,
  SyncQueueEntry,
  AuditLogEntry,
} from '../types/db-schemas';

let db: IDBDatabase | null = null;

export function getDB(): IDBDatabase {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

export async function initDB(): Promise<IDBDatabase> {
  if (db) return db;

  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const database = (event.target as IDBOpenDBRequest).result;
        const transaction = (event.target as IDBOpenDBRequest).transaction!;
        const oldVersion = event.oldVersion;
        runMigrations(database, oldVersion, DB_VERSION, transaction);
      };

      request.onsuccess = (event) => {
        db = (event.target as IDBOpenDBRequest).result;

        db.onerror = (e) => {
          console.error('Database error:', e);
        };

        resolve(db);
      };

      request.onerror = () => {
        reject(new Error('Failed to open database'));
      };
    } catch (err) {
      reject(err);
    }
  });
}

export async function closeDB(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
}

// Utility to wrap IDB requests in promises
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

// ── Profile operations ──

export async function getProfile(): Promise<UserProfile | undefined> {
  try {
    const database = getDB();
    const tx = database.transaction('user_profile', 'readonly');
    const store = tx.objectStore('user_profile');
    const profile = await promisifyRequest<UserProfile | undefined>(store.get('current'));
    // Retire legacy chest templates without removing historical assessment data.
    if (profile?.tug_step_calibration &&
        profile.tug_step_calibration.placement !== 'front_trouser_pocket') {
      delete profile.tug_step_calibration;
      profile.updated_at = new Date().toISOString();
      await saveProfile(profile);
    }
    return profile;
  } catch (err) {
    console.error('getProfile error:', err);
    return undefined;
  }
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  try {
    const database = getDB();
    const tx = database.transaction('user_profile', 'readwrite');
    const store = tx.objectStore('user_profile');
    store.put(profile);
    await promisifyTransaction(tx);
  } catch (err) {
    console.error('saveProfile error:', err);
    throw err;
  }
}

export async function deleteProfile(): Promise<void> {
  try {
    const database = getDB();
    const tx = database.transaction('user_profile', 'readwrite');
    const store = tx.objectStore('user_profile');
    store.delete('current');
    await promisifyTransaction(tx);
  } catch (err) {
    console.error('deleteProfile error:', err);
    throw err;
  }
}

// ── Assessment result operations ──

export async function saveResult(result: AssessmentResult): Promise<void> {
  try {
    const database = getDB();
    const tx = database.transaction('assessment_results', 'readwrite');
    const store = tx.objectStore('assessment_results');
    store.put(result);
    await promisifyTransaction(tx);
  } catch (err) {
    console.error('saveResult error:', err);
    throw err;
  }
}

export async function getResult(localUuid: string): Promise<AssessmentResult | undefined> {
  try {
    const database = getDB();
    const tx = database.transaction('assessment_results', 'readonly');
    const store = tx.objectStore('assessment_results');
    return await promisifyRequest(store.get(localUuid));
  } catch (err) {
    console.error('getResult error:', err);
    return undefined;
  }
}

export async function getAllResults(): Promise<AssessmentResult[]> {
  try {
    const profile = await getProfile();
    if (!profile) return [];

    const database = getDB();
    const tx = database.transaction('assessment_results', 'readonly');
    const store = tx.objectStore('assessment_results');
    const results: AssessmentResult[] = await promisifyRequest(store.getAll());
    return results.filter(
      (r) => r.participant_id === profile.participant_id && r.status !== 'in_progress',
    );
  } catch (err) {
    console.error('getAllResults error:', err);
    return [];
  }
}

export async function getResultsByTask(taskType: string): Promise<AssessmentResult[]> {
  try {
    const profile = await getProfile();
    if (!profile) return [];

    const database = getDB();
    const tx = database.transaction('assessment_results', 'readonly');
    const store = tx.objectStore('assessment_results');
    const index = store.index('by_task');
    const results: AssessmentResult[] = await promisifyRequest(index.getAll(taskType));
    return results.filter(
      (r) => r.participant_id === profile.participant_id && r.status !== 'in_progress',
    );
  } catch (err) {
    console.error('getResultsByTask error:', err);
    return [];
  }
}

export async function getResultsByTaskPrefix(prefix: string): Promise<AssessmentResult[]> {
  try {
    const all = await getAllResults();
    return all.filter((r) => r.task_type.startsWith(prefix));
  } catch (err) {
    console.error('getResultsByTaskPrefix error:', err);
    return [];
  }
}

export async function getUnsyncedResults(): Promise<AssessmentResult[]> {
  try {
    const profile = await getProfile();
    if (!profile) return [];

    const database = getDB();
    const tx = database.transaction('assessment_results', 'readonly');
    const store = tx.objectStore('assessment_results');
    const allResults: AssessmentResult[] = await promisifyRequest(store.getAll());
    return allResults.filter(
      (r) =>
        r.participant_id === profile.participant_id &&
        !r.synced &&
        (r.status === 'complete' || r.status === 'discarded'),
    );
  } catch (err) {
    console.error('getUnsyncedResults error:', err);
    return [];
  }
}

export async function getResultCount(): Promise<number> {
  try {
    const database = getDB();
    const tx = database.transaction('assessment_results', 'readonly');
    const store = tx.objectStore('assessment_results');
    return await promisifyRequest(store.count());
  } catch (err) {
    console.error('getResultCount error:', err);
    return 0;
  }
}

export async function deleteResult(localUuid: string): Promise<void> {
  try {
    const database = getDB();
    const tx = database.transaction('assessment_results', 'readwrite');
    const store = tx.objectStore('assessment_results');
    store.delete(localUuid);
    await promisifyTransaction(tx);
  } catch (err) {
    console.error('deleteResult error:', err);
    throw err;
  }
}

export async function pruneOldSyncedResults(maxCount: number = MAX_LOCAL_SESSIONS): Promise<number> {
  try {
    const database = getDB();
    const tx = database.transaction('assessment_results', 'readwrite');
    const store = tx.objectStore('assessment_results');
    const dateIndex = store.index('by_date');
    const all: AssessmentResult[] = await promisifyRequest(dateIndex.getAll());

    const syncedResults = all.filter((r) => r.synced && r.status === 'complete');
    if (syncedResults.length <= maxCount) return 0;

    // Sort oldest first
    syncedResults.sort(
      (a, b) => new Date(a.timestamp_start).getTime() - new Date(b.timestamp_start).getTime(),
    );

    const toDelete = syncedResults.slice(0, syncedResults.length - maxCount);
    for (const result of toDelete) {
      store.delete(result.local_uuid);
    }

    await promisifyTransaction(tx);
    return toDelete.length;
  } catch (err) {
    console.error('pruneOldSyncedResults error:', err);
    return 0;
  }
}

// ── Sync queue operations ──

export async function addToSyncQueue(entry: Omit<SyncQueueEntry, 'id'>): Promise<number> {
  try {
    const database = getDB();
    const tx = database.transaction('sync_queue', 'readwrite');
    const store = tx.objectStore('sync_queue');
    const id = await promisifyRequest(store.add(entry) as IDBRequest<number>);
    await promisifyTransaction(tx);
    return id;
  } catch (err) {
    console.error('addToSyncQueue error:', err);
    throw err;
  }
}

export async function getPendingSyncItems(): Promise<SyncQueueEntry[]> {
  try {
    const database = getDB();
    const tx = database.transaction('sync_queue', 'readonly');
    const store = tx.objectStore('sync_queue');
    const index = store.index('by_status');
    return await promisifyRequest(index.getAll('pending'));
  } catch (err) {
    console.error('getPendingSyncItems error:', err);
    return [];
  }
}

export async function updateSyncItem(item: SyncQueueEntry): Promise<void> {
  try {
    const database = getDB();
    const tx = database.transaction('sync_queue', 'readwrite');
    const store = tx.objectStore('sync_queue');
    store.put(item);
    await promisifyTransaction(tx);
  } catch (err) {
    console.error('updateSyncItem error:', err);
    throw err;
  }
}

export async function clearCompletedSyncItems(): Promise<void> {
  try {
    const database = getDB();
    const tx = database.transaction('sync_queue', 'readwrite');
    const store = tx.objectStore('sync_queue');
    const index = store.index('by_status');
    const completed: SyncQueueEntry[] = await promisifyRequest(index.getAll('completed'));
    for (const item of completed) {
      if (item.id !== undefined) store.delete(item.id);
    }
    await promisifyTransaction(tx);
  } catch (err) {
    console.error('clearCompletedSyncItems error:', err);
  }
}

// ── Audit log operations ──

export async function addAuditEntry(
  entry: Omit<AuditLogEntry, 'id' | 'timestamp'>,
): Promise<void> {
  try {
    const database = getDB();
    const tx = database.transaction('audit_log', 'readwrite');
    const store = tx.objectStore('audit_log');
    store.add({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    await promisifyTransaction(tx);
  } catch (err) {
    console.error('addAuditEntry error:', err);
  }
}

export async function getAuditLog(): Promise<AuditLogEntry[]> {
  try {
    const database = getDB();
    const tx = database.transaction('audit_log', 'readonly');
    const store = tx.objectStore('audit_log');
    return await promisifyRequest(store.getAll());
  } catch (err) {
    console.error('getAuditLog error:', err);
    return [];
  }
}

export async function pruneAuditLog(maxEntries: number = MAX_AUDIT_ENTRIES): Promise<void> {
  try {
    const database = getDB();
    const tx = database.transaction('audit_log', 'readwrite');
    const store = tx.objectStore('audit_log');
    const count = await promisifyRequest(store.count());

    if (count <= maxEntries) return;

    const index = store.index('by_timestamp');
    const cursor = index.openCursor();

    let deleted = 0;
    const toDelete = count - maxEntries;

    await new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c && deleted < toDelete) {
          c.delete();
          deleted++;
          c.continue();
        } else {
          resolve();
        }
      };
      cursor.onerror = () => reject(cursor.error);
    });

    await promisifyTransaction(tx);
  } catch (err) {
    console.error('pruneAuditLog error:', err);
  }
}

// ── Clear data ──

export async function clearAssessmentData(): Promise<void> {
  try {
    const database = getDB();
    const stores = ['assessment_results', 'sync_queue', 'audit_log'];

    for (const storeName of stores) {
      const tx = database.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      await promisifyTransaction(tx);
    }
  } catch (err) {
    console.error('clearAssessmentData error:', err);
    throw err;
  }
}
