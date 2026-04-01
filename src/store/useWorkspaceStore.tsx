import { create } from "zustand";
import type { Workspace } from "../types/workspace";
import {
  FREE_TIER_VALIDATION_MODE,
  normalizeInstrumentId,
  normalizeInstrumentPanels,
} from "../instruments";

const STORAGE_KEY = "trading_workspaces_v2";
const LEGACY_STORAGE_KEY = "trading_workspaces_v1";
const STORAGE_VERSION = 2;
const VALID_LAYOUT_TYPES = new Set(["1", "2", "3", "6"]);

type WorkspaceRecord = Partial<Workspace> & {
  theme?: unknown;
};

type WorkspaceEnvelope = {
  version: number;
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
};

type State = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  setActiveWorkspace: (id: string | null) => void;
  saveWorkspace: (ws: Workspace) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  deleteWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  createDefaultWorkspace: (defaultWs: Workspace) => void;
};

function sanitizeWorkspace(workspace: WorkspaceRecord): Workspace | null {
  if (typeof workspace.id !== "string" || workspace.id.trim().length === 0) {
    return null;
  }

  if (typeof workspace.name !== "string" || workspace.name.trim().length === 0) {
    return null;
  }

  const createdAt =
    typeof workspace.createdAt === "number" && Number.isFinite(workspace.createdAt)
      ? workspace.createdAt
      : Date.now();
  const updatedAt =
    typeof workspace.updatedAt === "number" && Number.isFinite(workspace.updatedAt)
      ? workspace.updatedAt
      : createdAt;
  const layoutType =
    typeof workspace.layoutType === "string" && VALID_LAYOUT_TYPES.has(workspace.layoutType)
      ? workspace.layoutType
      : "2";
  const panels = Array.isArray(workspace.panels)
    ? normalizeInstrumentPanels(workspace.panels)
    : [];
  const drawingsSource =
    workspace.drawingsBySymbol && typeof workspace.drawingsBySymbol === "object"
      ? workspace.drawingsBySymbol
      : {};
  const drawingsBySymbol = Object.entries(drawingsSource).reduce<Workspace["drawingsBySymbol"]>(
    (next, [symbol, drawings]) => {
      next[normalizeInstrumentId(symbol)] = drawings;
      return next;
    },
    {}
  );

  return {
    id: workspace.id,
    name: workspace.name.trim(),
    createdAt,
    updatedAt,
    layoutType,
    panels,
    drawingsBySymbol,
  };
}

function createEmptyEnvelope(): WorkspaceEnvelope {
  return {
    version: STORAGE_VERSION,
    activeWorkspaceId: null,
    workspaces: [],
  };
}

function persistEnvelope(envelope: WorkspaceEnvelope) {
  if (typeof window === "undefined" || FREE_TIER_VALIDATION_MODE) {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (error) {
    console.error("[WorkspaceStore] Failed to persist workspaces:", error);
  }
}

function normalizeEnvelope(parsed: Partial<WorkspaceEnvelope> | WorkspaceRecord[]): WorkspaceEnvelope {
  if (Array.isArray(parsed)) {
    const workspaces = parsed
      .map((workspace) => sanitizeWorkspace(workspace))
      .filter((workspace): workspace is Workspace => workspace !== null);

    return {
      version: STORAGE_VERSION,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      workspaces,
    };
  }

  const workspaces = Array.isArray(parsed.workspaces)
    ? parsed.workspaces
        .map((workspace) => sanitizeWorkspace(workspace))
        .filter((workspace): workspace is Workspace => workspace !== null)
    : [];
  const activeWorkspaceId =
    typeof parsed.activeWorkspaceId === "string" &&
    workspaces.some((workspace) => workspace.id === parsed.activeWorkspaceId)
      ? parsed.activeWorkspaceId
      : workspaces[0]?.id ?? null;

  return {
    version:
      typeof parsed.version === "number" && Number.isFinite(parsed.version)
        ? parsed.version
        : STORAGE_VERSION,
    activeWorkspaceId,
    workspaces,
  };
}

function loadEnvelope(): WorkspaceEnvelope {
  if (typeof window === "undefined" || FREE_TIER_VALIDATION_MODE) {
    return createEmptyEnvelope();
  }

  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return createEmptyEnvelope();
    }

    return normalizeEnvelope(
      JSON.parse(raw) as Partial<WorkspaceEnvelope> | WorkspaceRecord[]
    );
  } catch (error) {
    console.error("[WorkspaceStore] Failed to load workspaces:", error);
    return createEmptyEnvelope();
  }
}

const initialEnvelope = loadEnvelope();

export const useWorkspaceStore = create<State>((set) => ({
  workspaces: initialEnvelope.workspaces,
  activeWorkspaceId: initialEnvelope.activeWorkspaceId,

  setActiveWorkspace: (id) =>
    set((state) => {
      const activeWorkspaceId =
        id && state.workspaces.some((workspace) => workspace.id === id)
          ? id
          : state.workspaces[0]?.id ?? null;

      persistEnvelope({
        version: STORAGE_VERSION,
        activeWorkspaceId,
        workspaces: state.workspaces,
      });

      return { activeWorkspaceId };
    }),

  saveWorkspace: (workspace) =>
    set((state) => {
      const sanitizedWorkspace = sanitizeWorkspace(workspace);
      if (!sanitizedWorkspace) {
        return state;
      }

      const index = state.workspaces.findIndex((current) => current.id === sanitizedWorkspace.id);
      const workspaces =
        index >= 0
          ? state.workspaces.map((current, currentIndex) =>
              currentIndex === index ? sanitizedWorkspace : current
            )
          : [...state.workspaces, sanitizedWorkspace];
      const activeWorkspaceId = sanitizedWorkspace.id;

      persistEnvelope({
        version: STORAGE_VERSION,
        activeWorkspaceId,
        workspaces,
      });

      return {
        workspaces,
        activeWorkspaceId,
      };
    }),

  updateWorkspace: (id, updates) =>
    set((state) => {
      const workspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== id) {
          return workspace;
        }

        const sanitizedWorkspace = sanitizeWorkspace({
          ...workspace,
          ...updates,
          updatedAt: Date.now(),
        });

        return sanitizedWorkspace ?? workspace;
      });

      persistEnvelope({
        version: STORAGE_VERSION,
        activeWorkspaceId: state.activeWorkspaceId,
        workspaces,
      });

      return { workspaces };
    }),

  renameWorkspace: (id, name) =>
    set((state) => {
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, name, updatedAt: Date.now() } : workspace
      );

      persistEnvelope({
        version: STORAGE_VERSION,
        activeWorkspaceId: state.activeWorkspaceId,
        workspaces,
      });

      return { workspaces };
    }),

  deleteWorkspace: (id) =>
    set((state) => {
      const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
      const activeWorkspaceId =
        state.activeWorkspaceId === id ? workspaces[0]?.id ?? null : state.activeWorkspaceId;

      persistEnvelope({
        version: STORAGE_VERSION,
        activeWorkspaceId,
        workspaces,
      });

      return {
        workspaces,
        activeWorkspaceId,
      };
    }),

  createDefaultWorkspace: (defaultWorkspace) =>
    set((state) => {
      if (state.workspaces.length > 0) {
        return state;
      }

      const sanitizedWorkspace = sanitizeWorkspace(defaultWorkspace);
      if (!sanitizedWorkspace) {
        return state;
      }

      const workspaces = [sanitizedWorkspace];
      const activeWorkspaceId = sanitizedWorkspace.id;

      persistEnvelope({
        version: STORAGE_VERSION,
        activeWorkspaceId,
        workspaces,
      });

      return {
        workspaces,
        activeWorkspaceId,
      };
    }),
}));
