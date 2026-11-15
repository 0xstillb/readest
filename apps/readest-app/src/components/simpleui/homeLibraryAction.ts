/** One-shot handoff for Library actions selected on the Simple UI home screen. */
export type HomeLibraryAction =
  | 'import-files'
  | 'import-directory'
  | 'import-pasted-text'
  | 'import-web'
  | 'import-novel'
  | 'feeds'
  | 'catalogs'
  | 'select'
  | 'sync';

type PendingAction = {
  action: HomeLibraryAction;
  createdAt: number;
  fullRefresh?: boolean;
  verbose?: boolean;
};

const KEY = 'readest.simpleui.pendingLibraryAction';
const ACTIONS: HomeLibraryAction[] = [
  'import-files',
  'import-directory',
  'import-pasted-text',
  'import-web',
  'import-novel',
  'feeds',
  'catalogs',
  'select',
  'sync',
];

export const queueHomeLibraryAction = (
  action: HomeLibraryAction,
  options?: { fullRefresh?: boolean; verbose?: boolean },
) => {
  const pending: PendingAction = { action, createdAt: Date.now(), ...options };
  window.sessionStorage.setItem(KEY, JSON.stringify(pending));
};

export const takeHomeLibraryAction = (): PendingAction | null => {
  const raw = window.sessionStorage.getItem(KEY);
  window.sessionStorage.removeItem(KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingAction;
    const age = Date.now() - pending.createdAt;
    return ACTIONS.includes(pending.action) && Number.isFinite(age) && age >= 0 && age < 60_000
      ? pending
      : null;
  } catch {
    return null;
  }
};
