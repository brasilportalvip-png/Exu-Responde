import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCXxZXL1kEaJ2dG0l7Dsuf32Noc6p2QSFc",
  authDomain: "exu-responde.firebaseapp.com",
  projectId: "exu-responde",
  storageBucket: "exu-responde.firebasestorage.app",
  messagingSenderId: "974178142123",
  appId: "1:974178142123:web:c3829b0bf80507147af4ee"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export default app;