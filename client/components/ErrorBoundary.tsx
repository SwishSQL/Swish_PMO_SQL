import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { safeGet } from '../lib/app';

// Whatever breaks while showing a page, the person sees what to do instead of a blank screen.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] page failed to show:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const ar = safeGet('pmo.lang') === 'ar';
    return (
      <div className="app-failed" role="alert" dir={ar ? 'rtl' : 'ltr'}>
        <div className="app-failed-card">
          <strong>{ar ? 'تعذّر عرض الصفحة' : 'This page could not be shown'}</strong>
          <p>{ar ? 'غالبًا صدرت نسخة جديدة من النظام. أعد التحميل للمتابعة.' : 'A new version of the system was probably released. Reload to carry on.'}</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            {ar ? 'إعادة التحميل' : 'Reload'}
          </button>
        </div>
      </div>
    );
  }
}
