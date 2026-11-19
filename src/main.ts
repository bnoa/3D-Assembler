import './styles.css';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { loadManifold } from './geometry/csg';
import { App } from './ui/app';

// Start loading the solid-modelling engine in the background.
void loadManifold(wasmUrl);

// Installed app: the service worker keeps it working offline (built version only; the dev server
// serves fresh files).
if (import.meta.env.PROD && 'serviceWorker' in navigator && !('assemblerDesktop' in window)) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

const root = document.getElementById('app')!;
try {
  const app = new App(root);
  (window as unknown as { app: App }).app = app;
} catch (e) {
  // Without WebGL (disabled, or blocked by the browser after a crash) there is no 3D view: say so
  // instead of leaving a blank page.
  const webgl = /WebGL/i.test(String(e));
  root.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'max-width:520px;margin:15vh auto;padding:24px;font:16px "Segoe UI",system-ui,sans-serif;color:#eceef1;background:#2f3135;line-height:1.5';
  box.innerHTML = webgl
    ? '<h2 style="margin-top:0;font-weight:400">Vue 3D indisponible</h2><p>Le navigateur n’a pas pu créer de contexte WebGL. Fermez cet onglet puis rouvrez la page ; si le problème persiste, redémarrez le navigateur ou activez l’accélération graphique dans ses paramètres.</p>'
    : '<h2 style="margin-top:0;font-weight:400">Démarrage impossible</h2><p></p>';
  if (!webgl) box.querySelector('p')!.textContent = String(e);
  root.append(box);
  throw e;
}
