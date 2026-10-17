import { create } from "zustand";
import { ApiPath, StoreKey } from "../constant";
import {
  AppState,
  getLocalAppState,
  mergeAppState,
  setLocalAppState,
} from "../utils/sync";
import { useChatStore } from "./chat";
import { useAppConfig } from "./config";
import { useMaskStore } from "./mask";
import { usePromptStore } from "./prompt";
import { getClientConfig } from "../config/client";

export type AccountUser = {
  id: string;
  email: string;
  name?: string;
};

type AccountStatus = "loading" | "disabled" | "signedOut" | "signedIn";

// API keys in the access store stay on the device
const SYNCED_KEYS = [
  StoreKey.Chat,
  StoreKey.Mask,
  StoreKey.Prompt,
  StoreKey.Config,
] as const;

const PUSH_DEBOUNCE_MS = 3000;

async function authFetch(path: string, body?: object) {
  const res = await fetch(`${ApiPath.NeonAuth}/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message ?? data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

function getSyncedState() {
  const state = getLocalAppState();
  return Object.fromEntries(SYNCED_KEYS.map((k) => [k, state[k]]));
}

let applyingRemote = false;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribers: (() => void)[] = [];

export const useAccountStore = create<{
  status: AccountStatus;
  user?: AccountUser;
  syncing: boolean;
  lastSyncTime: number;
  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  sync: () => Promise<void>;
  push: () => Promise<void>;
}>((set, get) => ({
  status: "loading",
  user: undefined,
  syncing: false,
  lastSyncTime: 0,

  async init() {
    if (getClientConfig()?.isApp) {
      set({ status: "disabled" });
      return;
    }
    try {
      const res = await fetch(`${ApiPath.NeonAuth}/get-session`, {
        credentials: "same-origin",
      });
      if (res.status === 501 || res.status === 404) {
        set({ status: "disabled" });
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.user) {
        set({ status: "signedIn", user: data.user });
        await get().sync();
      } else {
        set({ status: "signedOut", user: undefined });
      }
    } catch (e) {
      console.error("[Account] failed to load session", e);
      set({ status: "disabled" });
    }
  },

  async signIn(email, password) {
    const data = await authFetch("sign-in/email", { email, password });
    set({ status: "signedIn", user: data?.user });
    await get().sync();
  },

  async signUp(email, password) {
    const data = await authFetch("sign-up/email", {
      email,
      password,
      name: email.split("@")[0],
    });
    set({ status: "signedIn", user: data?.user });
    await get().sync();
  },

  async signOut() {
    clearTimeout(pushTimer);
    unsubscribers.forEach((u) => u());
    unsubscribers = [];
    await authFetch("sign-out", {});
    set({ status: "signedOut", user: undefined, lastSyncTime: 0 });
  },

  // merge saved chats into this device, then save the merged result
  async sync() {
    if (get().status !== "signedIn" || get().syncing) return;
    set({ syncing: true });
    try {
      const res = await fetch(ApiPath.UserState, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { state: remote } = await res.json();

      if (remote) {
        const local = getLocalAppState();
        // access store is never synced, so merge it with itself
        mergeAppState(local, {
          ...local,
          ...remote,
          [StoreKey.Access]: local[StoreKey.Access],
        } as AppState);
        applyingRemote = true;
        setLocalAppState(local);
        applyingRemote = false;
      }

      set({ syncing: false });
      await get().push();
      watchLocalChanges();
    } catch (e) {
      set({ syncing: false });
      throw e;
    }
  },

  async push() {
    if (get().status !== "signedIn") return;
    const res = await fetch(ApiPath.UserState, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: getSyncedState() }),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    set({ lastSyncTime: Date.now() });
  },
}));

function watchLocalChanges() {
  if (unsubscribers.length > 0) return;

  const schedulePush = () => {
    if (applyingRemote) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      useAccountStore
        .getState()
        .push()
        .catch((e) => console.error("[Account] failed to save chats", e));
    }, PUSH_DEBOUNCE_MS);
  };

  unsubscribers = [
    useChatStore.subscribe(schedulePush),
    useMaskStore.subscribe(schedulePush),
    usePromptStore.subscribe(schedulePush),
    useAppConfig.subscribe(schedulePush),
  ];
}
