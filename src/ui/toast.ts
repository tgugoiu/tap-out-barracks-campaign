import { el } from '../util';

export interface ToastAction {
  label: string;
  run: () => void;
}

export class Toast {
  private timer = 0;

  constructor(private readonly node: HTMLElement) {}

  show(message: string, opts: { action?: ToastAction; ms?: number } = {}): void {
    window.clearTimeout(this.timer);
    this.node.replaceChildren();
    this.node.append(el('span', 'toast__text'));
    (this.node.firstChild as HTMLElement).textContent = message;
    if (opts.action) {
      const { action } = opts;
      const btn = el('button', 'toast__action', { type: 'button' });
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        this.hide();
        action.run();
      });
      const close = el('button', 'toast__close', { type: 'button', 'aria-label': 'Dismiss' });
      close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
      close.addEventListener('click', () => this.hide());
      this.node.append(btn, close);
    }
    this.node.classList.add('is-visible');
    this.timer = window.setTimeout(() => this.hide(), opts.ms ?? 2200);
  }

  hide(): void {
    window.clearTimeout(this.timer);
    this.node.classList.remove('is-visible');
  }
}
