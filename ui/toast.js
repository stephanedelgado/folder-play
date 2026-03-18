/**
 * ui/toast.js
 * Standalone toast notification utility.
 *
 * showToast(msg, { duration, action: { label, fn } })
 *   action — optional button inside the toast; clicking it runs fn() and dismisses.
 */

export function showToast(msg, { duration = 3500, action } = {}) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';

  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast__action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.fn(); dismiss(); });
    toast.appendChild(btn);
  }

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast--visible'));

  function dismiss() {
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }

  setTimeout(dismiss, duration);
}
