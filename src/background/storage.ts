import { normalizeSettings } from '../shared/config';
import type { Settings } from '../shared/config';

const PREFS = 'settings';
let privacy: Promise<unknown> | undefined;
export async function restrictStorage() {
  privacy ??= Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]).catch(error => { privacy = undefined; throw error; });
  await privacy;
}
export async function loadSettings(): Promise<Settings> {
  await restrictStorage();
  const settings = (await chrome.storage.local.get(PREFS))[PREFS] as Partial<Settings> | undefined;
  return normalizeSettings(settings);
}
export const saveSettings = (settings: Settings) => chrome.storage.local.set({ [PREFS]: normalizeSettings(settings) });
