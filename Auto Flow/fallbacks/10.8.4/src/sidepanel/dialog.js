// Auto Flow 10.8 confirm-dialog helper.
// Promise-based modal: showConfirm({title, body, confirmLabel, cancelLabel}) -> Promise<boolean>.
// Closes on Confirm (true), Cancel (false), Esc (false), backdrop click (false).
// Stacking: a second showConfirm queues until the first resolves.

let activeQueue = Promise.resolve();

export function showConfirm({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel" } = {}) {
  const next = activeQueue.then(() => openDialog({ title, body, confirmLabel, cancelLabel }));
  activeQueue = next.catch(() => {});
  return next;
}

function openDialog({ title, body, confirmLabel, cancelLabel }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "afw-dialog-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");

    const dialog = document.createElement("div");
    dialog.className = "afw-dialog";

    if (title) {
      const h = document.createElement("h3");
      h.textContent = title;
      dialog.appendChild(h);
    }
    if (body) {
      const p = document.createElement("p");
      p.textContent = body;
      dialog.appendChild(p);
    }

    const actions = document.createElement("div");
    actions.className = "afw-dialog-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "afw-cancel";
    cancel.textContent = cancelLabel;

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "afw-confirm";
    confirm.textContent = confirmLabel;

    actions.append(cancel, confirm);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);

    function close(value) {
      document.removeEventListener("keydown", onKey, true);
      backdrop.removeEventListener("click", onBackdrop);
      backdrop.remove();
      resolve(value);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter" && document.activeElement === confirm) {
        e.preventDefault();
        close(true);
      }
    }
    function onBackdrop(e) {
      if (e.target === backdrop) close(false);
    }

    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(backdrop);
    confirm.focus();
  });
}
