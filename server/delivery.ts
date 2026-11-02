import { HttpError } from './auth';

// The documents that come with a request to close a project. Two are required: the Project Closure Report and the
// signed Project Sign-Off Checklist (the templates are in server/templates). The Delivery Document is optional: a
// link (SharePoint, OneDrive, Drive...), a file, or both. Files are kept in the database. Only a few kinds of file
// are accepted, and one is always served as a download with a type the server chooses, never the one the browser
// claimed, so an uploaded page cannot run inside the system.

export const MAX_DELIVERY_BYTES = 8 * 1024 * 1024;

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  zip: 'application/zip',
};

export interface StoredFile {
  name: string;
  type: string;
  data: Buffer;
}

export interface ClosureDocs {
  url: string | null;
  file: StoredFile | null;
  report: StoredFile;
  checklist: StoredFile;
}

/** One uploaded file ({ name, data: base64 }), checked. Null when none was sent. */
function cleanFile(f: any, what: string): StoredFile | null {
  if (!f || typeof f !== 'object') return null;
  const name = typeof f.name === 'string' ? f.name.trim().replace(/[\\/\r\n"]/g, '_').slice(0, 160) : '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!name || !TYPES[ext]) throw new HttpError(400, `${what}: this kind of file is not accepted. Use PDF, Word, Excel, PowerPoint, an image, a text file or a zip.`);
  if (typeof f.data !== 'string') throw new HttpError(400, `${what}: the file did not arrive.`);
  const data = Buffer.from(f.data, 'base64');
  if (data.length === 0) throw new HttpError(400, `${what}: the file is empty.`);
  if (data.length > MAX_DELIVERY_BYTES) throw new HttpError(400, `${what}: the file is larger than 8 MB. Make it smaller (save as PDF) and try again.`);
  return { name, type: TYPES[ext], data };
}

/** The documents of a closure request, checked: the closure report and the sign-off checklist are required. */
export function cleanDelivery(body: any): ClosureDocs {
  let url: string | null = null;
  const rawUrl = typeof body?.deliveryUrl === 'string' ? body.deliveryUrl.trim() : '';
  if (rawUrl) {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new HttpError(400, 'The link to the delivery document is not a valid address.');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'The link must start with https://');
    if (rawUrl.length > 1000) throw new HttpError(400, 'The link is too long.');
    url = u.toString();
  }
  const file = cleanFile(body?.deliveryFile, 'Delivery document');
  const report = cleanFile(body?.reportFile, 'Project Closure Report');
  const checklist = cleanFile(body?.checklistFile, 'Project Sign-Off Checklist');
  if (!report || !checklist) {
    throw new HttpError(400, 'A project closes only with its Project Closure Report and its signed Project Sign-Off Checklist: attach both.');
  }
  return { url, file, report, checklist };
}

/** The templates people download, fill in and attach. */
export const TEMPLATES: Record<string, { file: string; name: string }> = {
  'closure-report': { file: 'Project Closure Report Template.docx', name: 'Project Closure Report Template.docx' },
  'sign-off-checklist': { file: 'Project Sign-Off Checklist Template.docx', name: 'Project Sign-Off Checklist Template.docx' },
};
