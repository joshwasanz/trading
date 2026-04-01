import { create } from "zustand";
import type { Workspace } from "../types/workspace";
import {
  FREE_TIER_VALIDATION_MODE,
  normalizeInstrumentId,
  normalizeInstrumentPanels,
} from "../instruments";

const STORAGE_KEY = "trading_workspaces_v1";

type WorkspaceRecord = Workspace & {
  theme?: unknown;
};

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
  if (FREE_TIER_VALIDATION_MODE) return [];

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed)
        ? parsed.map((workspace) => sanitizeWorkspace(workspace as WorkspaceRecord))
        : [];
    }
  } catch (error) {
    console.error("[WorkspaceStore] Failed to load workspaces:", error);
  }

  return [];
}

function sanitizeWorkspace(workspace: WorkspaceRecord): Workspace {
  const panels = Array.isArray(workspace.panels)
    ? normalizeInstrumentPanels(workspace.panels)
    : [];
  const drawingsBySymbol = Object.entries(workspace.drawingsBySymbol ?? {}).reduce<
    Workspace["drawingsBySymbol"]
  >((next, [symbol, drawings]) => {
    next[normalizeInstrumentId(symbol)] = drawings;
    return next;
  }, {});

  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    layoutType: workspace.layoutType,
    panels,
    drawingsBySymbol,
  };
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
      const sanitizedWorkspace = sanitizeWorkspace(ws as WorkspaceRecord);

      const updated = index >= 0
        ? existing.map((w, i) => i === index ? sanitizedWorkspace : w)
        : [...existing, sanitizedWorkspace];

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
        w.id === id
          ? sanitizeWorkspace({
              ...w,
              ...updates,
              updatedAt: Date.now(),
            } as WorkspaceRecord)
          : w
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

      const sanitizedWorkspace = sanitizeWorkspace(defaultWs as WorkspaceRecord);
      const updated = [sanitizedWorkspace];

      // Persist to localStorage
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error("[WorkspaceStore] Failed to create default workspace:", error);
      }

      return {
        workspaces: updated,
        activeWorkspaceId: sanitizedWorkspace.id,
      };
    });
  },
}));
