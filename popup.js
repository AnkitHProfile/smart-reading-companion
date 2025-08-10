(function () {
  const statusEl = document.getElementById('status');
  const toggleEl = document.getElementById('toggle');

  let enabled = true;

  function render() {
    toggleEl.dataset.on = enabled ? 'true' : 'false';
    toggleEl.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    statusEl.textContent = enabled
      ? 'Extension is enabled. The TL;DR button will appear on articles.'
      : 'Extension is disabled. The TL;DR button will be hidden on all pages.';
  }

  function setEnabled(next) {
    enabled = !!next;
    chrome.storage.sync.set({ enabled }, render);
  }

  // Load current value
  chrome.storage.sync.get({ enabled: true }, (obj) => {
    enabled = !!obj.enabled;
    render();
  });

  // Click to toggle
  toggleEl.addEventListener('click', () => setEnabled(!enabled));
})();