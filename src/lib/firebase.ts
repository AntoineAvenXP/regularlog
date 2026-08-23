import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  getFirestore,
  type Firestore,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";

// Analytics volontairement NON initialisé (cf. spécification §2).
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Auto-détection du long-polling : évite les blocages infinis quand la
// connexion streaming (WebChannel) de Firestore est filtrée par une extension
// (AdBlock…), un proxy ou un réseau restrictif. Repli propre en hot-reload.
let _db: Firestore;
try {
  _db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
  });
} catch {
  _db = getFirestore(app);
}
export const db = _db;

export const storage = getStorage(app);
// Relevés scannés parfois lourds : on laisse plus de temps aux upload/download
// avant d'abandonner (défaut = 2 min → erreur storage/retry-limit-exceeded).
storage.maxUploadRetryTime = 600000; // 10 min
storage.maxOperationRetryTime = 300000; // 5 min

export const functions = getFunctions(app, "europe-west1");
export default app;
