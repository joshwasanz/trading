import { create } from "zustand";
import type { Workspace } from "../types/workspace";

const STORAGE_KEY = "trading_workspaces_v1";

type State = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  setActiveWorkspace: (id: string) => void;
  saveWorkspace: (ws: Workspace) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  deleteWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  createDefaultWorkspace: (defaultWs: Workspace) => void;
};

function loadWorkspacesFromStorage(): Workspace[] {
  if (typeof window === "undefined") return [];

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error("[WorkspaceStore] Failed to load workspaces:", error);
  }

  return [];
}

export const useWorkspaceStore = create<State>((set) => ({
  workspaces: loadWorkspacesFromStorage(),
  activeWorkspaceId: null,

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
  },

  saveWorkspace: (ws) => {
    set((state) => {
      const existing = state.workspaces;
      const index = existing.findIndex((w) => w.id === ws.id);

      const updated = index >= 0
        ? existing.map((w, i) => i === index ? ws : w)
        : [...existing, ws];

      // Persist to localStorage
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error("[WorkspaceStore] Failed to save workspaces:", error);
      }

      return { workspaces: updated };
    });
  },

  deleteWorkspace: (id) => {
    set((state) => {
      const updated = state.workspaces.filter((w) => w.id !== id);

      // Persist to localStorage
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error("[WorkspaceStore] Failed to delete workspace:", error);
      }

      return {
        workspaces: updated,
        activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
      };
    });
  },

  renameWorkspace: (id, name) => {
    set((state) => {
      const updated = state.workspaces.map((w) =>
        w.id === id ? { ...w, name, updatedAt: Date.now() } : w
      );

      // Persist to localStorage
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error("[WorkspaceStore] Failed to rename workspace:", error);
      }

      return { workspaces: updated };
    });
  },

  updateWorkspace: (id, updates) => {
    set((state) => {
      const updated = state.workspaces.map((w) =>
        w.id === id ? { ...w, ...updates, updatedAt: Date.now() } : w
      );

      // Persist to localStorage
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error("[WorkspaceStore] Failed to update workspace:", error);
      }

      return { workspaces: updated };
    });
  },

  createDefaultWorkspace: (defaultWs) => {
    set((state) => {
      if (state.workspaces.length > 0) return state;

      const updated = [defaultWs];

      // Persist to localStorage
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error("[WorkspaceStore] Failed to create default workspace:", error);
      }

      return {
        workspaces: updated,
        activeWorkspaceId: defaultWs.id,
      };
    });
  },
}));
