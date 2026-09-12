/**
 * Preload bridge for the dual-screen connect window: `window.mcConnect` only.
 *
 * It must share NO runtime module with electron/preload.ts — preloads run
 * sandboxed, where `require` cannot resolve sibling chunks, so a shared import
 * would be split into out/preload/chunks/*.js and both preloads would fail to
 * load silently (see the comment in electron.vite.config.ts). Channel names are
 * restated as literals and pinned to the real table with a type-only
 * `satisfies Pick<typeof IPC, …>`, so a rename breaks this file at compile time.
 *
 * The surface is deliberately narrow. This window exists to show a QR code and
 * a pairing code; it gets a read-only settings snapshot and a companion-only
 * write channel, never the full settings:set (which could rewrite API keys).
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type CompanionState,
  type PublicSettings,
  type SettingsPatch,
} from '../shared/protocol';

const CH = {
  companionState: 'companion:state',
  companionApply: 'companion:apply',
  companionPair: 'companion:pair',
  companionRevoke: 'companion:revoke',
  companionQr: 'companion:qr',
  companionShot: 'companion:shot',
  companionPatch: 'companion:patch',
  settingsGet: 'settings:get',
  connectClose: 'connect:close',
} as const satisfies Pick<
  typeof IPC,
  | 'companionState'
  | 'companionApply'
  | 'companionPair'
  | 'companionRevoke'
  | 'companionQr'
  | 'companionShot'
  | 'companionPatch'
  | 'settingsGet'
  | 'connectClose'
>;

export type CompanionPatch = NonNullable<SettingsPatch['companion']>;

export interface McConnectApi {
  readonly platform: NodeJS.Platform;
  /** for the UI language and the hotkey labels shown next to each action */
  getSettings(): Promise<PublicSettings>;
  state(): Promise<CompanionState>;
  /** rebind after changing port / HTTPS */
  apply(): Promise<CompanionState>;
  /** write the companion section only */
  patch(p: CompanionPatch): Promise<CompanionState>;
  /** SVG of the reach URL — rendered big, this is what a phone scans */
  qr(): Promise<string>;
  pair(): Promise<CompanionState>;
  revoke(name: string): Promise<CompanionState>;
  /** capture now and push, so the button mirrors the hotkey */
  shot(): Promise<{ ok: boolean; ms: number; seq: number }>;
  hide(): void;
}

const api: McConnectApi = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke(CH.settingsGet),
  state: () => ipcRenderer.invoke(CH.companionState),
  apply: () => ipcRenderer.invoke(CH.companionApply),
  patch: (p) => ipcRenderer.invoke(CH.companionPatch, p),
  qr: () => ipcRenderer.invoke(CH.companionQr),
  pair: () => ipcRenderer.invoke(CH.companionPair),
  revoke: (name) => ipcRenderer.invoke(CH.companionRevoke, name),
  shot: () => ipcRenderer.invoke(CH.companionShot),
  hide: () => ipcRenderer.send(CH.connectClose),
};

contextBridge.exposeInMainWorld('mcConnect', api);
