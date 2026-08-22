import { normalizeAuthorColorOverrides, type AuthorColorOverrides } from "./author-color";

export const SETTINGS_VERSION = 1;

export type ResolveBehavior = "keep" | "remove";
export type ExportScope = "all" | "open";
export type ExportDestination = "source" | "folder";
export type SidebarSortOrder = "document" | "newest" | "oldest";
export type SubmitShortcut = "enter" | "mod-enter";
export type TimestampDisplay = "full" | "compact" | "relative" | "hidden";

export interface CommentsSettings {
  settingsVersion: number;
  highlightColor: string;
  highlightOpacity: number;
  colorAuthorNames: boolean;
  showResolvedByDefault: boolean;
  resolveBehavior: ResolveBehavior;
  sidebarSortOrder: SidebarSortOrder;
  submitShortcut: SubmitShortcut;
  timestampDisplay: TimestampDisplay;
  confirmDestructiveActions: boolean;
  showReadingViewIndicator: boolean;
  schemaHint: boolean;
  /** When true, record keystroke/persist counters and log budget overruns to the console. */
  debugPerf: boolean;
  copyIncludeQuote: boolean;
  exportNameTemplate: string;
  exportScope: ExportScope;
  exportDestination: ExportDestination;
  exportFolder: string;
  authorColorOverrides: AuthorColorOverrides;
}

export const DEFAULT_SETTINGS: CommentsSettings = {
  settingsVersion: SETTINGS_VERSION,
  highlightColor: "#ffd54a",
  highlightOpacity: 30,
  colorAuthorNames: true,
  showResolvedByDefault: false,
  resolveBehavior: "remove",
  sidebarSortOrder: "document",
  submitShortcut: "enter",
  timestampDisplay: "full",
  confirmDestructiveActions: true,
  showReadingViewIndicator: true,
  schemaHint: true,
  debugPerf: false,
  copyIncludeQuote: true,
  exportNameTemplate: "{{filename}} – Comments",
  exportScope: "all",
  exportDestination: "source",
  exportFolder: "",
  authorColorOverrides: {},
};

export interface ParsedCommentsSettings {
  settings: CommentsSettings;
  legacyAuthorName?: string;
  changed: boolean;
}

export interface SettingsEffects {
  refreshHighlights: boolean;
  refreshAuthorColors: boolean;
  refreshSidebar: boolean;
  refreshReadingViewIndicator: boolean;
  resetResolvedVisibility: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function enumSetting<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function opacitySetting(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.highlightOpacity;
  return Math.min(80, Math.max(10, Math.round(value)));
}

export function normalizeVaultFolderPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

export function validateVaultFolderPath(value: string): string | null {
  const path = normalizeVaultFolderPath(value);
  if (path.split("/").some((part) => part === "." || part === "..")) {
    return "Choose a folder inside the vault.";
  }
  return null;
}

export function parseCommentsSettings(value: unknown): ParsedCommentsSettings {
  const raw = isRecord(value) ? value : {};
  const template = stringSetting(raw.exportNameTemplate, DEFAULT_SETTINGS.exportNameTemplate)
    .trim()
    .replace(/\.md$/i, "");
  const resolveBehavior = enumSetting(
    raw.resolveBehavior,
    ["keep", "remove"] as const,
    DEFAULT_SETTINGS.resolveBehavior
  );
  const settings: CommentsSettings = {
    settingsVersion: SETTINGS_VERSION,
    highlightColor:
      typeof raw.highlightColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.highlightColor)
        ? raw.highlightColor.toLowerCase()
        : DEFAULT_SETTINGS.highlightColor,
    highlightOpacity: opacitySetting(raw.highlightOpacity),
    colorAuthorNames: booleanSetting(raw.colorAuthorNames, DEFAULT_SETTINGS.colorAuthorNames),
    showResolvedByDefault:
      resolveBehavior === "keep" &&
      booleanSetting(raw.showResolvedByDefault, DEFAULT_SETTINGS.showResolvedByDefault),
    resolveBehavior,
    sidebarSortOrder: enumSetting(
      raw.sidebarSortOrder,
      ["document", "newest", "oldest"] as const,
      DEFAULT_SETTINGS.sidebarSortOrder
    ),
    submitShortcut: enumSetting(
      raw.submitShortcut,
      ["enter", "mod-enter"] as const,
      DEFAULT_SETTINGS.submitShortcut
    ),
    timestampDisplay: enumSetting(
      raw.timestampDisplay,
      ["full", "compact", "relative", "hidden"] as const,
      DEFAULT_SETTINGS.timestampDisplay
    ),
    confirmDestructiveActions: booleanSetting(
      raw.confirmDestructiveActions,
      DEFAULT_SETTINGS.confirmDestructiveActions
    ),
    showReadingViewIndicator: booleanSetting(
      raw.showReadingViewIndicator,
      DEFAULT_SETTINGS.showReadingViewIndicator
    ),
    schemaHint: booleanSetting(raw.schemaHint, DEFAULT_SETTINGS.schemaHint),
    debugPerf: booleanSetting(raw.debugPerf, DEFAULT_SETTINGS.debugPerf),
    copyIncludeQuote: booleanSetting(raw.copyIncludeQuote, DEFAULT_SETTINGS.copyIncludeQuote),
    exportNameTemplate: template || DEFAULT_SETTINGS.exportNameTemplate,
    exportScope: enumSetting(raw.exportScope, ["all", "open"] as const, DEFAULT_SETTINGS.exportScope),
    exportDestination: enumSetting(
      raw.exportDestination,
      ["source", "folder"] as const,
      DEFAULT_SETTINGS.exportDestination
    ),
    exportFolder:
      validateVaultFolderPath(stringSetting(raw.exportFolder, DEFAULT_SETTINGS.exportFolder)) === null
        ? normalizeVaultFolderPath(raw.exportFolder)
        : DEFAULT_SETTINGS.exportFolder,
    authorColorOverrides: normalizeAuthorColorOverrides(raw.authorColorOverrides),
  };
  const legacyAuthorName = typeof raw.authorName === "string" ? raw.authorName.trim() : undefined;
  return {
    settings,
    legacyAuthorName: legacyAuthorName || undefined,
    changed: JSON.stringify(value ?? {}) !== JSON.stringify(settings),
  };
}

export function validateExportNameTemplate(value: string): string | null {
  if (!value.trim()) return "Enter an export note name.";
  if (/\.md\s*$/i.test(value)) return "Leave off the .md extension; Tandem Comments adds it automatically.";
  return null;
}

export function settingsEffects(previous: CommentsSettings, next: CommentsSettings): SettingsEffects {
  const resetResolvedVisibility = previous.showResolvedByDefault !== next.showResolvedByDefault;
  return {
    refreshHighlights:
      previous.highlightColor !== next.highlightColor ||
      previous.highlightOpacity !== next.highlightOpacity,
    refreshAuthorColors:
      previous.colorAuthorNames !== next.colorAuthorNames ||
      JSON.stringify(previous.authorColorOverrides) !== JSON.stringify(next.authorColorOverrides),
    refreshSidebar:
      resetResolvedVisibility ||
      previous.sidebarSortOrder !== next.sidebarSortOrder ||
      previous.timestampDisplay !== next.timestampDisplay,
    refreshReadingViewIndicator:
      previous.showReadingViewIndicator !== next.showReadingViewIndicator,
    resetResolvedVisibility,
  };
}
