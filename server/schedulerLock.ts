import {
  getFirestoreDb,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  withTimeout,
} from './firestore.js';

export interface PersistentSchedulerDoc {
  stateId: string;
  lastGenerationDate: string | null;
  lastDeliveryDate: string | null;
  lastDay3EvaluationDate: string | null;
  activeLockInstanceId: string | null;
  lockedUntil: string | null;
  updatedAt: string;
}

const SCHEDULER_DOC_ID = 'singleton';

let localLockInstanceId: string | null = null;
let localLockExpiry: number = 0;

/**
 * Attempts to acquire a distributed lock in Firestore for scheduler execution.
 * Prevents concurrent Cloud Run instances from running duplicate tasks.
 */
export async function acquireDistributedSchedulerLock(
  instanceId: string,
  ttlSeconds: number = 90
): Promise<boolean> {
  const now = Date.now();
  if (localLockInstanceId && localLockInstanceId !== instanceId && localLockExpiry > now) {
    return false;
  }

  const firestore = getFirestoreDb();
  const lockRef = doc(firestore, 'schedulerState', SCHEDULER_DOC_ID);
  const nowDate = new Date();
  const lockExpiry = new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString();

  // Establish local lock guard
  localLockInstanceId = instanceId;
  localLockExpiry = now + ttlSeconds * 1000;

  try {
    const txnPromise = runTransaction(firestore, async (txn) => {
      const snap = await txn.get(lockRef);
      if (snap.exists()) {
        const data = snap.data() as PersistentSchedulerDoc;
        if (
          data.lockedUntil &&
          new Date(data.lockedUntil) > nowDate &&
          data.activeLockInstanceId &&
          data.activeLockInstanceId !== instanceId
        ) {
          // Locked by another active instance
          return false;
        }
      }

      txn.set(
        lockRef,
        {
          stateId: SCHEDULER_DOC_ID,
          activeLockInstanceId: instanceId,
          lockedUntil: lockExpiry,
          updatedAt: nowDate.toISOString(),
        },
        { merge: true }
      );
      return true;
    });

    const acquired = await withTimeout(txnPromise, 2000, true);
    if (!acquired) {
      localLockInstanceId = null;
      localLockExpiry = 0;
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[DistributedLock] Notice acquiring lock (preserving local guard):', err instanceof Error ? err.message : err);
    return true;
  }
}

/**
 * Releases the distributed lock in Firestore if held by this instance.
 */
export async function releaseDistributedSchedulerLock(instanceId: string): Promise<void> {
  if (localLockInstanceId === instanceId) {
    localLockInstanceId = null;
    localLockExpiry = 0;
  }
  const firestore = getFirestoreDb();
  const lockRef = doc(firestore, 'schedulerState', SCHEDULER_DOC_ID);
  try {
    const txnPromise = runTransaction(firestore, async (txn) => {
      const snap = await txn.get(lockRef);
      if (snap.exists()) {
        const data = snap.data() as PersistentSchedulerDoc;
        if (data.activeLockInstanceId === instanceId) {
          txn.set(
            lockRef,
            {
              activeLockInstanceId: null,
              lockedUntil: null,
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        }
      }
    });
    await withTimeout(txnPromise, 2000, undefined);
  } catch (err) {
    console.warn('[DistributedLock] Notice releasing lock:', err instanceof Error ? err.message : err);
  }
}

/**
 * Reads persistent last generation & delivery dates from Firestore.
 */
export async function getPersistentSchedulerDates(): Promise<{
  lastGenerationDate: string | null;
  lastDeliveryDate: string | null;
}> {
  const firestore = getFirestoreDb();
  const lockRef = doc(firestore, 'schedulerState', SCHEDULER_DOC_ID);
  try {
    const snap = await withTimeout(getDoc(lockRef), 2000, null);
    if (snap && snap.exists()) {
      const data = snap.data() as PersistentSchedulerDoc;
      return {
        lastGenerationDate: data.lastGenerationDate || null,
        lastDeliveryDate: data.lastDeliveryDate || null,
      };
    }
  } catch (err) {
    console.warn('[DistributedLock] Notice reading persistent dates:', err instanceof Error ? err.message : err);
  }
  return { lastGenerationDate: null, lastDeliveryDate: null };
}

/**
 * Updates persistent last generation or delivery date in Firestore.
 */
export async function setPersistentSchedulerDates(dates: {
  lastGenerationDate?: string;
  lastDeliveryDate?: string;
}): Promise<void> {
  const firestore = getFirestoreDb();
  const lockRef = doc(firestore, 'schedulerState', SCHEDULER_DOC_ID);
  try {
    const setPromise = setDoc(
      lockRef,
      {
        ...dates,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    await withTimeout(setPromise, 2000, undefined);
  } catch (err) {
    console.warn('[DistributedLock] Notice setting persistent dates:', err instanceof Error ? err.message : err);
  }
}
