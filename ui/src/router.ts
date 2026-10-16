import { useEffect, useState } from 'react';

export const ROUTES = ['/estate', '/clusters', '/runs', '/audit'] as const;
export type Route = (typeof ROUTES)[number];

const current = (): Route => (ROUTES as readonly string[]).includes(window.location.pathname) ? window.location.pathname as Route : '/estate';

/** Guards set by views with unsaved edits; navigation asks before discarding them. */
const guards = new Set<() => boolean>();
export function addUnsavedGuard(isDirty: () => boolean): () => void {
  guards.add(isDirty);
  return () => { guards.delete(isDirty); };
}
export const hasUnsaved = () => [...guards].some(g => g());

export function navigate(to: Route): void {
  if (to === window.location.pathname) return;
  if (hasUnsaved() && !window.confirm('You have unsaved changes on this page. Leave without saving?')) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('studio:navigate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const update = () => setRoute(current());
    window.addEventListener('popstate', update);
    window.addEventListener('studio:navigate', update);
    const unload = (e: BeforeUnloadEvent) => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('popstate', update); window.removeEventListener('studio:navigate', update); window.removeEventListener('beforeunload', unload); };
  }, []);
  return route;
}
