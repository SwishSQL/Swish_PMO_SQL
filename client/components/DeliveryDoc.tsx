import { FileText, LinkSimple, ListChecks, Paperclip } from '@phosphor-icons/react';
import { useT } from '../lib/i18n';

/** The documents of a closure request: the closure report and sign-off checklist, and the delivery link and/or file. */
export function DeliveryDoc({
  requestId,
  url,
  fileName,
  reportFileName,
  checklistFileName,
}: {
  requestId: number;
  url: string | null;
  fileName: string | null;
  reportFileName?: string | null;
  checklistFileName?: string | null;
}) {
  const { t } = useT();
  if (!url && !fileName && !reportFileName && !checklistFileName) return null;
  const doc = (kind: string) => `/api/closure-requests/${requestId}/document?kind=${kind}`;
  return (
    <span className="delivery-doc" style={{ display: 'inline-flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      {reportFileName && (
        <a href={doc('report')} download style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }} title={reportFileName}>
          <FileText size={14} aria-hidden /> {t('closureReport')}
        </a>
      )}
      {checklistFileName && (
        <a href={doc('checklist')} download style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }} title={checklistFileName}>
          <ListChecks size={14} aria-hidden /> {t('closureChecklist')}
        </a>
      )}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <LinkSimple size={14} aria-hidden /> {t('deliveryLink')}
        </a>
      )}
      {fileName && (
        <a href={doc('delivery')} download style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }} dir="ltr">
          <Paperclip size={14} aria-hidden /> {fileName}
        </a>
      )}
    </span>
  );
}

/** A chosen file as base64, for the request. Refuses what the server would refuse, so the person finds out at once. */
export function readDeliveryFile(file: File, onError: (m: string) => void): Promise<{ name: string; data: string } | null> {
  return new Promise((resolve) => {
    if (file.size > 8 * 1024 * 1024) {
      onError('big');
      resolve(null);
      return;
    }
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, data: String(r.result).split(',')[1] ?? '' });
    r.onerror = () => {
      onError('read');
      resolve(null);
    };
    r.readAsDataURL(file);
  });
}
