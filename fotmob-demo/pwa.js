(function () {
  'use strict';

  const installButton = document.getElementById('install-cta');
  const banner = document.getElementById('pwa-install-banner');
  const bannerAction = document.getElementById('pwa-install-action');
  const bannerDismiss = document.getElementById('pwa-install-dismiss');
  const title = document.getElementById('pwa-install-title');
  const subtitle = document.getElementById('pwa-install-subtitle');
  const help = document.getElementById('pwa-install-help');
  const helpClose = document.getElementById('pwa-help-close');
  const helpCopy = document.getElementById('pwa-help-copy');
  const helpSteps = document.getElementById('pwa-help-steps');
  let deferredPrompt = null;
  let installMode = null;

  const ua = navigator.userAgent || '';
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /safari/i.test(ua) && !/(crios|fxios|edgios|opios|chrome|chromium|android)/i.test(ua);
  const standaloneQuery = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;

  function isInstalled() {
    return Boolean((standaloneQuery && standaloneQuery.matches) || navigator.standalone === true);
  }

  function sessionFlag(key) {
    try { return sessionStorage.getItem(key) === '1'; } catch (_) { return false; }
  }

  function setSessionFlag(key) {
    try { sessionStorage.setItem(key, '1'); } catch (_) { /* Storage may be unavailable in private mode. */ }
  }

  function hideInstallUI() {
    if (installButton) installButton.hidden = true;
    if (banner) banner.hidden = true;
    if (help) help.hidden = true;
  }

  function showInstallUI(mode) {
    if (!installButton || !banner || isInstalled() || sessionFlag('matchday-pwa-prompt-dismissed')) {
      hideInstallUI();
      return;
    }

    installMode = mode;
    const isIOSGuide = mode === 'ios';
    if (title) title.textContent = 'Install Matchday';
    if (subtitle) {
      subtitle.textContent = isIOSGuide
        ? (isSafari ? 'Add Matchday to your Home Screen for one-tap access.' : 'Open this page in Safari to add Matchday to your Home Screen.')
        : 'Keep football scores and news one tap away.';
    }
    if (bannerAction) bannerAction.textContent = isIOSGuide ? 'How to install' : 'Install';
    installButton.hidden = false;
    banner.hidden = sessionFlag('matchday-pwa-banner-dismissed');
  }

  function openIOSGuide() {
    if (!help) return;
    if (helpCopy) {
      helpCopy.textContent = isSafari
        ? 'In Safari, tap Share, then choose Add to Home Screen.'
        : 'For iPhone installation, open this Matchday page in Safari, then use its Share menu.';
    }
    if (helpSteps) {
      helpSteps.innerHTML = isSafari
        ? '<li>Tap the <strong>Share</strong> button.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Tap <strong>Add</strong> to finish.</li>'
        : '<li>Open this page in <strong>Safari</strong>.</li><li>Tap <strong>Share</strong>, then choose <strong>Add to Home Screen</strong>.</li><li>Tap <strong>Add</strong> to finish.</li>';
    }
    help.hidden = false;
    if (helpClose) helpClose.focus();
  }

  function closeIOSGuide() {
    if (help) help.hidden = true;
    if (installButton) installButton.focus();
  }

  function dismissBanner() {
    if (banner) banner.hidden = true;
    setSessionFlag('matchday-pwa-banner-dismissed');
  }

  function dismissPromptForSession() {
    deferredPrompt = null;
    setSessionFlag('matchday-pwa-prompt-dismissed');
    hideInstallUI();
  }

  async function requestInstall() {
    if (isInstalled()) {
      hideInstallUI();
      return;
    }
    if (deferredPrompt) {
      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      try {
        await promptEvent.prompt();
        const result = await promptEvent.userChoice;
        if (result && result.outcome === 'accepted') {
          hideInstallUI();
        } else {
          dismissPromptForSession();
        }
      } catch (error) {
        console.warn('Matchday install prompt could not be opened:', error);
        dismissPromptForSession();
      }
      return;
    }
    if (installMode === 'ios') openIOSGuide();
  }

  if (installButton) installButton.addEventListener('click', requestInstall);
  if (bannerAction) bannerAction.addEventListener('click', requestInstall);
  if (bannerDismiss) bannerDismiss.addEventListener('click', dismissBanner);
  if (helpClose) helpClose.addEventListener('click', closeIOSGuide);
  if (help) help.addEventListener('click', event => { if (event.target === help) closeIOSGuide(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && help && !help.hidden) closeIOSGuide();
  });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    showInstallUI('native');
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallUI();
  });

  function syncInstalledState() {
    if (isInstalled()) hideInstallUI();
  }

  if (standaloneQuery) {
    if (standaloneQuery.addEventListener) standaloneQuery.addEventListener('change', syncInstalledState);
    else if (standaloneQuery.addListener) standaloneQuery.addListener(syncInstalledState);
  }

  if (isInstalled()) {
    hideInstallUI();
  } else if (isIOS) {
    showInstallUI('ios');
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(error => {
      console.warn('Matchday offline support could not be enabled:', error);
    });
  }
})();
