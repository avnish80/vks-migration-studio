import { useEffect, useState } from 'react';

export const ROUTES = ['/estate', '/clusters', '/runs', '/audit'] as const;
export type Route = (typeof ROUTES)[number];
export interface Location { route: Route; params: URLSearchParams }

const here = () => window.location.pathname + window.location.search;
const current = (): Location => ({
  route: (ROUTES as readonly string[]).includes(window.location.pathname) ? window.location.pathname as Route : '/estate',
  params: new URLSearchParams(window.location.search),
});

/** Guards set by views with unsaved edits; navigation asks before discarding them. */
const guards = new Set<() => boolean>();
export function addUnsavedGuard(isDirty: () => boolean): () => void {
  guards.add(isDirty);
  return () => { guards.delete(isDirty); };
}
export const hasUnsaved = () => [...guards].some(g => g());
const LEAVE = 'You have unsaved changes on this page. Leave without saving?';

/** Navigate to a route, optionally with query parameters (for example /estate?project=…). */
export function navigate(to: string): void {
  if (to === here()) return;
  if (hasUnsaved() && !window.confirm(LEAVE)) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('studio:navigate'));
}

export function useLocation(): Location {
  const [location, setLocation] = useState<Location>(current);
  useEffect(() => {
    let shown = here();
    const update = () => { shown = here(); setLocation(current()); };
    // Back and forward: ask first, and put the address back if the user stays.
    const pop = () => {
      if (here() !== shown && hasUnsaved() && !window.confirm(LEAVE)) { window.history.pushState(null, '', shown); return; }
      update();
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('studio:navigate', update);
    const unload = (e: BeforeUnloadEvent) => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('studio:navigate', update); window.removeEventListener('beforeunload', unload); };
  }, []);
  return location;
}
