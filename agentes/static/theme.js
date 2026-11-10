(() => {
  'use strict';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'dark';
  try { preference = localStorage.getItem('agentes-theme') || 'dark'; } catch {}
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'dark';

  function apply() {
    const dark = preference === 'dark' || (preference === 'system' && system.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#062d24' : '#edf5ee';
    const select = document.querySelector('#theme-preference');
    if (select) select.value = preference;
    const toggle = document.querySelector('#theme-toggle');
    if (toggle) {
      toggle.textContent = dark ? 'Tema claro' : 'Tema escuro';
      toggle.setAttribute('aria-label', dark ? 'Usar tema claro' : 'Usar tema escuro');
      toggle.title = dark ? 'Usar tema claro' : 'Usar tema escuro';
    }
  }
  function choose(value) {
    preference = value;
    try { localStorage.setItem('agentes-theme', value); } catch {}
    apply();
  }
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key !== 'agentes-theme' && event.key !== null) return;
    preference = ['light', 'dark', 'system'].includes(event.newValue) ? event.newValue : 'dark';
    apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelector('#theme-toggle')?.addEventListener('click', () => choose(root.dataset.theme === 'dark' ? 'light' : 'dark'));
    document.querySelector('#theme-preference')?.addEventListener('change', event => choose(event.target.value));
  });
})();
