import fs from 'fs';
import path from 'path';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  Firestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  runTransaction,
  writeBatch,
  Transaction,
} from 'firebase/firestore';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let firestoreInstance: Firestore | null = null;

export function getFirestoreDb(): Firestore {
  if (firestoreInstance) {
    return firestoreInstance;
  }

  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('firebase-applet-config.json not found. Firebase must be configured.');
  }

  const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

  // CRITICAL: The app will break without specifying firestoreDatabaseId
  firestoreInstance = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  return firestoreInstance;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 2500,
  fallbackVal?: T
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (fallbackVal !== undefined) {
        resolve(fallbackVal);
      } else {
        reject(new Error(`Firestore operation timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

export async function testFirestoreConnection(): Promise<boolean> {
  const db = getFirestoreDb();
  try {
    // Verify connectivity via fast read check
    const categoriesColl = collection(db, 'categories');
    const snap = await withTimeout(getDocs(categoriesColl), 3000);
    return snap.size >= 0;
  } catch (error) {
    console.warn('[Firestore] Connection check notice:', error instanceof Error ? error.message : error);
    return false;
  }
}

export {
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  runTransaction,
  writeBatch,
  type Transaction,
};
